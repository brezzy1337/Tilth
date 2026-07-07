/**
 * Unit tests for verifyMuxSignature, handleMuxWebhookRequest, and handleMuxEvent.
 *
 * These tests are FAST — no real DB, no network.
 *
 * Coverage:
 *   verifyMuxSignature:
 *     - valid signature verifies
 *     - invalid signature (wrong secret / tampered body) is rejected
 *     - stale timestamp (> 5 min old) is rejected
 *     - malformed header (missing t= or v1=) is rejected
 *
 *   handleMuxWebhookRequest:
 *     - valid signature → 200, dispatches to handleMuxEvent
 *     - missing mux-signature header → 400
 *     - invalid signature → 400
 *     - webhookSecret undefined (Mux not configured) → 400, never calls the DB
 *
 *   handleMuxEvent — exactly-once dedup (mirrors webhook.test.ts's Stripe coverage):
 *     - same event.id delivered twice → side effect runs only once
 *
 *   handleMuxEvent — event handlers:
 *     - video.asset.ready → status 'ready', sets muxAssetId/muxPlaybackId/durationS
 *     - video.upload.errored → status 'errored'
 *     - video.asset.errored → status 'errored'
 *     - unknown event type → ignored, no DB write
 */

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { verifyMuxSignature, handleMuxWebhookRequest, handleMuxEvent, type MuxEvent } from "./webhook-mux";
import type { Db } from "./context";

const SECRET = "mux_webhook_test_secret";

function signPayload(rawBody: string, secret: string, tsSeconds: number): string {
  const signedPayload = `${tsSeconds}.${rawBody}`;
  const v1 = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${tsSeconds},v1=${v1}`;
}

// ---------------------------------------------------------------------------
// verifyMuxSignature
// ---------------------------------------------------------------------------

describe("verifyMuxSignature", () => {
  it("verifies a valid signature", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = signPayload(body.toString("utf8"), SECRET, nowSeconds);

    expect(verifyMuxSignature(body, header, SECRET)).toBe(true);
  });

  it("rejects a signature signed with the wrong secret", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = signPayload(body.toString("utf8"), "wrong_secret", nowSeconds);

    expect(verifyMuxSignature(body, header, SECRET)).toBe(false);
  });

  it("rejects when the body has been tampered with after signing", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = signPayload("original body", SECRET, nowSeconds);
    const tamperedBody = Buffer.from("tampered body");

    expect(verifyMuxSignature(tamperedBody, header, SECRET)).toBe(false);
  });

  it("rejects a stale timestamp (> 5 minutes old)", () => {
    const body = Buffer.from("{}");
    const staleSeconds = Math.floor(Date.now() / 1000) - 6 * 60; // 6 minutes ago
    const header = signPayload("{}", SECRET, staleSeconds);

    expect(verifyMuxSignature(body, header, SECRET)).toBe(false);
  });

  it("rejects a timestamp more than 5 minutes in the future", () => {
    const body = Buffer.from("{}");
    const futureSeconds = Math.floor(Date.now() / 1000) + 6 * 60;
    const header = signPayload("{}", SECRET, futureSeconds);

    expect(verifyMuxSignature(body, header, SECRET)).toBe(false);
  });

  it("accepts a timestamp within the 5-minute window", () => {
    const body = Buffer.from("{}");
    const withinWindow = Math.floor(Date.now() / 1000) - 4 * 60; // 4 minutes ago
    const header = signPayload("{}", SECRET, withinWindow);

    expect(verifyMuxSignature(body, header, SECRET)).toBe(true);
  });

  it("rejects a malformed header missing v1", () => {
    const body = Buffer.from("{}");
    const header = `t=${Math.floor(Date.now() / 1000)}`;

    expect(verifyMuxSignature(body, header, SECRET)).toBe(false);
  });

  it("rejects a malformed header missing t", () => {
    const body = Buffer.from("{}");
    const header = "v1=deadbeef";

    expect(verifyMuxSignature(body, header, SECRET)).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    const body = Buffer.from("{}");
    const header = "t=notanumber,v1=deadbeef";

    expect(verifyMuxSignature(body, header, SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fake DB helper for handleMuxEvent tests (mirrors webhook.test.ts's fakeEventDb)
// ---------------------------------------------------------------------------

function fakeMuxEventDb(opts: {
  claimResult?: { id: string }[];
  onTxUpdate?: (set: unknown) => void;
}): Db {
  const claimRows = opts.claimResult ?? [{ id: "mux_evt_test" }];

  const txInsertBuilder = {
    values: () => txInsertBuilder,
    onConflictDoNothing: () => txInsertBuilder,
    returning: () => Promise.resolve(claimRows),
  };

  const txUpdateBuilder = {
    set: (s: unknown) => {
      opts.onTxUpdate?.(s);
      return txUpdateBuilder;
    },
    where: () => txUpdateBuilder,
    then: (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve),
  };

  const tx = {
    insert: () => txInsertBuilder,
    update: () => txUpdateBuilder,
  };

  return {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
}

// ---------------------------------------------------------------------------
// handleMuxEvent — exactly-once dedup
// ---------------------------------------------------------------------------

describe("handleMuxEvent — exactly-once dedup", () => {
  it("runs the side effect when the event is new (claim returns a row)", async () => {
    const updates: unknown[] = [];
    const db = fakeMuxEventDb({ claimResult: [{ id: "mux_evt_1" }], onTxUpdate: (s) => updates.push(s) });

    const event: MuxEvent = {
      id: "mux_evt_1",
      type: "video.asset.ready",
      data: { passthrough: "11111111-1111-4111-8111-111111111111", playback_ids: [{ id: "pb123" }] },
    };

    await handleMuxEvent(event, { db });

    expect(updates).toHaveLength(1);
  });

  it("skips the side effect when the event is a duplicate (claim returns empty)", async () => {
    const updates: unknown[] = [];
    const db = fakeMuxEventDb({ claimResult: [], onTxUpdate: (s) => updates.push(s) });

    const event: MuxEvent = {
      id: "mux_evt_dup",
      type: "video.asset.ready",
      data: { passthrough: "11111111-1111-4111-8111-111111111111", playback_ids: [{ id: "pb123" }] },
    };

    await handleMuxEvent(event, { db });

    expect(updates).toHaveLength(0);
  });

  it("delivers same event twice — side effect runs only once", async () => {
    let claimCallCount = 0;
    const updates: unknown[] = [];

    const makeDb = () => {
      const callIndex = claimCallCount++;
      return fakeMuxEventDb({
        claimResult: callIndex === 0 ? [{ id: "mux_evt_double" }] : [],
        onTxUpdate: (s) => updates.push(s),
      });
    };

    const event: MuxEvent = {
      id: "mux_evt_double",
      type: "video.asset.ready",
      data: { passthrough: "11111111-1111-4111-8111-111111111111", playback_ids: [{ id: "pb123" }] },
    };

    await handleMuxEvent(event, { db: makeDb() });
    await handleMuxEvent(event, { db: makeDb() });

    expect(updates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// handleMuxEvent — video.asset.ready
// ---------------------------------------------------------------------------

describe("handleMuxEvent — video.asset.ready", () => {
  it("sets status ready, muxAssetId, muxPlaybackId, and durationS", async () => {
    const updates: unknown[] = [];
    const db = fakeMuxEventDb({ onTxUpdate: (s) => updates.push(s) });

    const event: MuxEvent = {
      id: "mux_evt_ready",
      type: "video.asset.ready",
      data: {
        id: "asset_abc123",
        passthrough: "22222222-2222-4222-8222-222222222222",
        playback_ids: [{ id: "pb_abc123", policy: "public" }],
        duration: 12.5,
      },
    };

    await handleMuxEvent(event, { db });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "ready",
      muxAssetId: "asset_abc123",
      muxPlaybackId: "pb_abc123",
      durationS: 12.5,
    });
  });

  it("falls back to matching on muxUploadId (data.upload_id) when passthrough is absent", async () => {
    const updates: unknown[] = [];
    const db = fakeMuxEventDb({ onTxUpdate: (s) => updates.push(s) });

    const event: MuxEvent = {
      id: "mux_evt_ready_no_passthrough",
      type: "video.asset.ready",
      data: {
        id: "asset_no_pt",
        upload_id: "upload_no_pt",
        playback_ids: [{ id: "pb_no_pt" }],
        duration: 5,
      },
    };

    await handleMuxEvent(event, { db });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "ready", muxPlaybackId: "pb_no_pt" });
  });

  it("no-ops safely when both passthrough and upload_id are absent", async () => {
    const updates: unknown[] = [];
    const db = fakeMuxEventDb({ onTxUpdate: (s) => updates.push(s) });

    const event: MuxEvent = {
      id: "mux_evt_ready_uncorrelatable",
      type: "video.asset.ready",
      data: { id: "asset_orphan", playback_ids: [{ id: "pb_orphan" }] },
    };

    await handleMuxEvent(event, { db });

    expect(updates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleMuxEvent — error events
// ---------------------------------------------------------------------------

describe("handleMuxEvent — error events", () => {
  it("video.upload.errored sets status to errored", async () => {
    const updates: unknown[] = [];
    const db = fakeMuxEventDb({ onTxUpdate: (s) => updates.push(s) });

    const event: MuxEvent = {
      id: "mux_evt_upload_errored",
      type: "video.upload.errored",
      data: { id: "upload_xyz", passthrough: "33333333-3333-4333-8333-333333333333" },
    };

    await handleMuxEvent(event, { db });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "errored" });
  });

  it("video.asset.errored sets status to errored", async () => {
    const updates: unknown[] = [];
    const db = fakeMuxEventDb({ onTxUpdate: (s) => updates.push(s) });

    const event: MuxEvent = {
      id: "mux_evt_asset_errored",
      type: "video.asset.errored",
      data: { id: "asset_xyz", passthrough: "44444444-4444-4444-8444-444444444444" },
    };

    await handleMuxEvent(event, { db });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "errored" });
  });

  it("video.asset.errored without passthrough correlates via data.upload_id, not the asset id", async () => {
    const updates: unknown[] = [];
    const db = fakeMuxEventDb({ onTxUpdate: (s) => updates.push(s) });

    const event: MuxEvent = {
      id: "mux_evt_asset_errored_no_pt",
      type: "video.asset.errored",
      data: { id: "asset_only_id", upload_id: "upload_for_errored" },
    };

    await handleMuxEvent(event, { db });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "errored" });
  });
});

// ---------------------------------------------------------------------------
// handleMuxEvent — unknown event type (no-op)
// ---------------------------------------------------------------------------

describe("handleMuxEvent — unknown event type", () => {
  it("ignores unknown event types without throwing", async () => {
    const updates: unknown[] = [];
    const db = fakeMuxEventDb({ onTxUpdate: (s) => updates.push(s) });

    const event: MuxEvent = {
      id: "mux_evt_unknown",
      type: "video.upload.created",
      data: {},
    };

    await expect(handleMuxEvent(event, { db })).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleMuxWebhookRequest — HTTP-level
// ---------------------------------------------------------------------------

/** Build a fake IncomingMessage that emits the given body then "end". */
function fakeReqWithBody(body: string, sig: string | undefined): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  emitter.headers = sig !== undefined ? { "mux-signature": sig } : {};
  setImmediate(() => {
    emitter.emit("data", Buffer.from(body));
    emitter.emit("end");
  });
  return emitter;
}

function makeFakeRes(): { res: ServerResponse; captured: { statusCode?: number; body?: string } } {
  const captured: { statusCode?: number; body?: string } = {};
  const res = {
    writeHead(code: number) {
      captured.statusCode = code;
    },
    end(data?: string) {
      captured.body = data;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

const stubDbForHttp = fakeMuxEventDb({});

describe("handleMuxWebhookRequest", () => {
  it("verifies and dispatches a validly-signed event → 200", async () => {
    const { res, captured } = makeFakeRes();
    const body = JSON.stringify({ id: "mux_evt_http_ok", type: "video.upload.created", data: {} });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sig = signPayload(body, SECRET, nowSeconds);
    const req = fakeReqWithBody(body, sig);

    handleMuxWebhookRequest(req, res, { db: stubDbForHttp, webhookSecret: SECRET });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(captured.statusCode).toBe(200);
    expect(captured.body).toContain('"received":true');
  });

  it("returns 400 when mux-signature header is missing", async () => {
    const { res, captured } = makeFakeRes();
    const req = fakeReqWithBody("{}", undefined);

    handleMuxWebhookRequest(req, res, { db: stubDbForHttp, webhookSecret: SECRET });

    await new Promise((resolve) => setImmediate(resolve));

    expect(captured.statusCode).toBe(400);
    const parsed = JSON.parse(captured.body ?? "{}") as { error: string };
    expect(parsed.error).toContain("mux-signature");
  });

  it("returns 400 when the signature is invalid", async () => {
    const { res, captured } = makeFakeRes();
    const body = "{}";
    const sig = signPayload(body, "wrong-secret", Math.floor(Date.now() / 1000));
    const req = fakeReqWithBody(body, sig);

    handleMuxWebhookRequest(req, res, { db: stubDbForHttp, webhookSecret: SECRET });

    await new Promise((resolve) => setImmediate(resolve));

    expect(captured.statusCode).toBe(400);
  });

  it("returns 400 and never touches the DB when webhookSecret is undefined (Mux not configured)", async () => {
    const { res, captured } = makeFakeRes();
    const body = "{}";
    const sig = signPayload(body, SECRET, Math.floor(Date.now() / 1000));
    const req = fakeReqWithBody(body, sig);

    let dbTouched = false;
    const dbSpy = {
      transaction: async () => {
        dbTouched = true;
      },
    } as unknown as Db;

    handleMuxWebhookRequest(req, res, { db: dbSpy, webhookSecret: undefined });

    await new Promise((resolve) => setImmediate(resolve));

    expect(captured.statusCode).toBe(400);
    expect(dbTouched).toBe(false);
  });
});
