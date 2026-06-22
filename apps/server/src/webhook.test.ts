/**
 * Unit tests for handleStripeWebhookRequest — multi-secret verification.
 *
 * These tests are FAST — no DB, no network, no Stripe SDK.
 * They use a fake constructWebhookEvent that throws unless the passed secret
 * matches a known value, mirroring how Stripe's real implementation works.
 *
 * Coverage:
 *   - An event signed with the FIRST secret (platform) verifies and dispatches.
 *   - An event signed with the SECOND secret (connect) verifies and dispatches.
 *   - An event signed with NEITHER secret returns 400.
 *   - A missing stripe-signature header returns 400 (existing behavior preserved).
 */

import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Stripe from "stripe";
import { EventEmitter } from "node:events";
import { handleStripeWebhookRequest } from "./webhook";
import type { Db } from "./context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a fake constructWebhookEvent that succeeds only when `secret` matches
 * one of the `validSecrets`. Otherwise throws, mimicking Stripe's HMAC mismatch error.
 */
function makeConstructWebhookEvent(validSecrets: string[]) {
  return (_rawBody: Buffer, _signature: string, secret: string): Stripe.Event => {
    if (!validSecrets.includes(secret)) {
      throw new Error("No signatures found matching the expected signature for payload");
    }
    // Return a minimal valid-shaped Stripe.Event (type-cast for test purposes).
    return {
      id: "evt_test",
      type: "payment_intent.payment_failed", // no-op event — no DB side effects
      data: { object: {} },
    } as unknown as Stripe.Event;
  };
}

/** Build a fake IncomingMessage that emits the given body then "end". */
function fakeReqWithBody(body: string, sig: string | undefined): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  emitter.headers = sig !== undefined ? { "stripe-signature": sig } : {};
  // Emit after the synchronous call returns so listeners are attached first.
  setImmediate(() => {
    emitter.emit("data", Buffer.from(body));
    emitter.emit("end");
  });
  return emitter;
}

/**
 * Build a minimal fake ServerResponse together with a capture bag for assertions.
 * The ServerResponse is cast via `unknown` to avoid fighting Node's overloaded
 * writeHead / end signatures in tests.
 */
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

/** Minimal stub Db — not called for payment_intent.payment_failed (no-op). */
const stubDb = {} as unknown as Db;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SECRET_PLATFORM = "whsec_platform_secret";
const SECRET_CONNECT = "whsec_connect_secret";
const SECRET_UNKNOWN = "whsec_totally_wrong";

describe("handleStripeWebhookRequest — multi-secret verification", () => {
  it("verifies and dispatches when signed with the FIRST secret (platform)", async () => {
    const { res, captured } = makeFakeRes();
    const req = fakeReqWithBody("body", "t=1,v1=aaa");

    handleStripeWebhookRequest(req, res, {
      db: stubDb,
      webhookSecrets: [SECRET_PLATFORM, SECRET_CONNECT],
      constructWebhookEvent: makeConstructWebhookEvent([SECRET_PLATFORM]),
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(captured.statusCode).toBe(200);
    expect(captured.body).toContain('"received":true');
  });

  it("verifies and dispatches when signed with the SECOND secret (connect)", async () => {
    const { res, captured } = makeFakeRes();
    const req = fakeReqWithBody("body", "t=1,v1=bbb");

    handleStripeWebhookRequest(req, res, {
      db: stubDb,
      webhookSecrets: [SECRET_PLATFORM, SECRET_CONNECT],
      constructWebhookEvent: makeConstructWebhookEvent([SECRET_CONNECT]),
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(captured.statusCode).toBe(200);
    expect(captured.body).toContain('"received":true');
  });

  it("returns 400 when the event is signed with NEITHER secret", async () => {
    const { res, captured } = makeFakeRes();
    const req = fakeReqWithBody("body", "t=1,v1=ccc");

    handleStripeWebhookRequest(req, res, {
      db: stubDb,
      webhookSecrets: [SECRET_PLATFORM, SECRET_CONNECT],
      constructWebhookEvent: makeConstructWebhookEvent([SECRET_UNKNOWN]),
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(captured.statusCode).toBe(400);
    const parsed = JSON.parse(captured.body ?? "{}") as { error: string };
    expect(parsed.error).toBeTruthy();
  });

  it("returns 400 when stripe-signature header is missing", async () => {
    const { res, captured } = makeFakeRes();
    const req = fakeReqWithBody("body", undefined);

    handleStripeWebhookRequest(req, res, {
      db: stubDb,
      webhookSecrets: [SECRET_PLATFORM, SECRET_CONNECT],
      constructWebhookEvent: makeConstructWebhookEvent([SECRET_PLATFORM]),
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(captured.statusCode).toBe(400);
    const parsed = JSON.parse(captured.body ?? "{}") as { error: string };
    expect(parsed.error).toContain("stripe-signature");
  });

  it("calls constructWebhookEvent once when first secret succeeds (short-circuits)", async () => {
    const { res, captured } = makeFakeRes();
    const req = fakeReqWithBody("body", "t=1,v1=ddd");
    const spy = vi.fn(makeConstructWebhookEvent([SECRET_PLATFORM]));

    handleStripeWebhookRequest(req, res, {
      db: stubDb,
      webhookSecrets: [SECRET_PLATFORM, SECRET_CONNECT],
      constructWebhookEvent: spy,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(captured.statusCode).toBe(200);
    // Called exactly once — stopped after the first success, did NOT try the second secret.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(Buffer), "t=1,v1=ddd", SECRET_PLATFORM);
  });

  it("calls constructWebhookEvent twice when only the second secret succeeds", async () => {
    const { res, captured } = makeFakeRes();
    const req = fakeReqWithBody("body", "t=1,v1=eee");
    const spy = vi.fn(makeConstructWebhookEvent([SECRET_CONNECT]));

    handleStripeWebhookRequest(req, res, {
      db: stubDb,
      webhookSecrets: [SECRET_PLATFORM, SECRET_CONNECT],
      constructWebhookEvent: spy,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(captured.statusCode).toBe(200);
    // First attempt (platform secret) throws, second (connect secret) succeeds.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, expect.any(Buffer), "t=1,v1=eee", SECRET_PLATFORM);
    expect(spy).toHaveBeenNthCalledWith(2, expect.any(Buffer), "t=1,v1=eee", SECRET_CONNECT);
  });
});
