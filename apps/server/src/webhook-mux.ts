/**
 * Mux webhook handler — raw-body, outside tRPC. Mirrors `webhook.ts` (Stripe).
 *
 * Mounted at `POST /webhooks/mux` in `index.ts`. Receives raw request bytes
 * before any JSON parsing so the `Mux-Signature` header can be verified via
 * HMAC-SHA256 over `${timestamp}.${rawBody}` (node:crypto, timing-safe compare).
 *
 * `Mux-Signature` header format:  t=<unix seconds>,v1=<hex hmac-sha256>
 * A signature whose timestamp is more than 5 minutes old (or in the future by
 * more than 5 minutes) is rejected as stale — the same replay-window discipline
 * Stripe's SDK applies.
 *
 * Exactly-once semantics mirror `webhook.ts`: every event is wrapped in a DB
 * transaction that first claims the event id in `processed_mux_events` via
 * INSERT … ON CONFLICT DO NOTHING. A crash mid-handler rolls back the claim so
 * a Mux retry (Mux retries non-2xx responses) reprocesses the event.
 *
 * Event dispatch:
 *   video.asset.ready          → processing → ready; sets muxAssetId,
 *                                 muxPlaybackId (first public playback id),
 *                                 durationS.
 *   video.upload.errored       → status → errored (upload never produced an asset).
 *   video.asset.errored        → status → errored (asset encoding failed).
 *   everything else            → ignore (respond 200 — Mux expects 200 on delivery).
 *
 * Post correlation: `garden.createVideo` sets `new_asset_settings.passthrough`
 * to the garden_posts.id at upload-creation time, so every asset-level event
 * payload's `data.passthrough` (or `data.new_asset_settings.passthrough` for
 * upload-level events) is the post id directly — no secondary lookup needed.
 * Falls back to matching on `mux_upload_id` for upload-level events that omit
 * passthrough.
 *
 * HTTP status semantics (same as Stripe's webhook):
 *   400 — missing / invalid / stale Mux-Signature, or webhook not configured
 *   500 — event processing error (Mux WILL retry)
 *   200 — event handled or intentionally ignored
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { Db } from "./context";
import { gardenPosts, processedMuxEvents } from "./db/schema";

/** Reject signatures whose timestamp is further than this from "now" (ms). */
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/** Minimal shape of a Mux webhook event — we never depend on the Mux SDK. */
export interface MuxEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Signature verification — pure, unit-testable
// ---------------------------------------------------------------------------

/**
 * Verify a `Mux-Signature` header of the form `t=<unix seconds>,v1=<hex hmac>`.
 *
 * @param rawBody   - the exact raw request bytes (verification is byte-sensitive).
 * @param header    - the raw `Mux-Signature` header value.
 * @param secret    - `MUX_WEBHOOK_SECRET`.
 * @param nowMs     - injectable "current time" for deterministic tests.
 * @returns true iff the signature is well-formed, matches, and is not stale.
 */
export function verifyMuxSignature(
  rawBody: Buffer,
  header: string,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  const parts = new Map<string, string>();
  for (const segment of header.split(",")) {
    const eqIdx = segment.indexOf("=");
    if (eqIdx === -1) continue;
    parts.set(segment.slice(0, eqIdx).trim(), segment.slice(eqIdx + 1).trim());
  }

  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1) return false;

  const tsSeconds = Number(t);
  if (!Number.isFinite(tsSeconds)) return false;

  const tsMs = tsSeconds * 1000;
  if (Math.abs(nowMs - tsMs) > MAX_SIGNATURE_AGE_MS) return false;

  const signedPayload = Buffer.concat([Buffer.from(`${t}.`, "utf8"), rawBody]);
  const expectedHex = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  let expectedBuf: Buffer;
  let actualBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedHex, "hex");
    actualBuf = Buffer.from(v1, "hex");
  } catch {
    return false;
  }

  // timingSafeEqual throws on length mismatch — guard explicitly first.
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// ---------------------------------------------------------------------------
// HTTP-level handler — collects raw body, verifies signature, dispatches
// ---------------------------------------------------------------------------

export function handleMuxWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    db: Db;
    /** Undefined when MUX_WEBHOOK_SECRET is unset — every request is then rejected. */
    webhookSecret: string | undefined;
  },
): void {
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    const rawBody = Buffer.concat(chunks);
    const sig = req.headers["mux-signature"];

    if (!opts.webhookSecret) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Mux webhook is not configured" }));
      return;
    }

    if (typeof sig !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing mux-signature header" }));
      return;
    }

    if (!verifyMuxSignature(rawBody, sig, opts.webhookSecret)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Signature verification failed" }));
      return;
    }

    let event: MuxEvent;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as MuxEvent;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON payload" }));
      return;
    }

    handleMuxEvent(event, { db: opts.db })
      .then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      })
      .catch((err: unknown) => {
        console.error(
          "[webhook-mux] error processing event",
          event.type,
          err instanceof Error ? err.message : String(err),
        );
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Event processing failed" }));
      });
  });

  req.on("error", (err) => {
    console.error("[webhook-mux] request read error", err instanceof Error ? err.message : String(err));
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to read request body" }));
  });
}

// ---------------------------------------------------------------------------
// Correlation helpers — extract the garden_posts.id / mux upload id from a payload
// ---------------------------------------------------------------------------

function extractPostId(data: Record<string, unknown>): string | null {
  if (typeof data["passthrough"] === "string") return data["passthrough"];
  const settings = data["new_asset_settings"];
  if (
    settings &&
    typeof settings === "object" &&
    typeof (settings as Record<string, unknown>)["passthrough"] === "string"
  ) {
    return (settings as Record<string, unknown>)["passthrough"] as string;
  }
  return null;
}

function extractUploadId(data: Record<string, unknown>): string | null {
  return typeof data["id"] === "string" ? data["id"] : null;
}

// On asset-level events (video.asset.*), data.id is the ASSET id; the
// originating direct-upload id rides in data.upload_id.
function extractAssetUploadId(data: Record<string, unknown>): string | null {
  return typeof data["upload_id"] === "string" ? data["upload_id"] : null;
}

function extractPlaybackId(data: Record<string, unknown>): string | null {
  const playbackIds = data["playback_ids"];
  if (!Array.isArray(playbackIds) || playbackIds.length === 0) return null;
  const first = playbackIds[0] as Record<string, unknown> | undefined;
  return typeof first?.["id"] === "string" ? (first["id"] as string) : null;
}

// ---------------------------------------------------------------------------
// Pure event dispatcher — unit-testable
// ---------------------------------------------------------------------------

export async function handleMuxEvent(event: MuxEvent, deps: { db: Db }): Promise<void> {
  const { db } = deps;

  await db.transaction(async (tx) => {
    const claimed = await tx
      .insert(processedMuxEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: processedMuxEvents.id });

    if (claimed.length === 0) {
      // Already processed — exactly-once semantics.
      return;
    }

    switch (event.type) {
      case "video.asset.ready": {
        const data = event.data;
        const postId = extractPostId(data);
        const assetId = extractUploadId(data); // event.data.id is the ASSET id on this event
        const uploadId = extractAssetUploadId(data);
        const playbackId = extractPlaybackId(data);
        const durationRaw = data["duration"];
        const durationS = typeof durationRaw === "number" ? durationRaw : null;

        const whereClause = postId
          ? eq(gardenPosts.id, postId)
          : uploadId
            ? eq(gardenPosts.muxUploadId, uploadId)
            : null;
        if (!whereClause) break;

        await tx
          .update(gardenPosts)
          .set({
            status: "ready",
            muxAssetId: assetId,
            muxPlaybackId: playbackId,
            durationS,
          })
          .where(and(whereClause, eq(gardenPosts.status, "processing")));
        break;
      }

      case "video.upload.errored":
      case "video.asset.errored": {
        const data = event.data;
        const postId = extractPostId(data);
        // upload.errored: data.id IS the upload id. asset.errored: the upload
        // id is data.upload_id (data.id would be the asset id — never equal to
        // our stored muxUploadId).
        const uploadId =
          event.type === "video.upload.errored"
            ? extractUploadId(data)
            : extractAssetUploadId(data);

        const whereClause = postId
          ? eq(gardenPosts.id, postId)
          : uploadId
            ? eq(gardenPosts.muxUploadId, uploadId)
            : null;
        if (!whereClause) break;

        await tx.update(gardenPosts).set({ status: "errored" }).where(whereClause);
        break;
      }

      default:
        // Unknown event type — ignore silently; Mux expects 200.
        break;
    }
  });
}
