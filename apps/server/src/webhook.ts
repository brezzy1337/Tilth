/**
 * Stripe webhook handler — raw-body, outside tRPC.
 *
 * Mounted at `POST /webhooks/stripe` in `index.ts`. Receives raw request bytes
 * before any JSON parsing so that `stripe.webhooks.constructEvent` can verify
 * the HMAC signature. Only after successful verification is the payload parsed.
 *
 * `handleStripeEvent` is exported separately so it can be unit-tested without
 * a live HTTP request.
 *
 * Exactly-once semantics:
 *   Every event is wrapped in a DB transaction that first claims the event id in
 *   `processed_stripe_events` via INSERT … ON CONFLICT DO NOTHING. If the row
 *   already exists the handler short-circuits (returns without side effects). A
 *   crash mid-handler rolls back the claim so Stripe's retry reprocesses the event.
 *
 * Event dispatch:
 *   payment_intent.succeeded    → pending_payment → paid (idempotent via markOrderPaid)
 *   payment_intent.canceled     → pending_payment → cancelled (terminal)
 *   payment_intent.payment_failed → no-op (buyer can retry)
 *   charge.refunded             → update refundedCents; flip to refunded on full refund
 *   charge.dispute.created      → flip to disputed
 *   account.updated             → authoritative re-fetch from Stripe, then update store flags
 *   everything else             → ignore (respond 200 — Stripe expects 200 on delivery)
 *
 * HTTP status semantics:
 *   400 — missing / invalid Stripe signature (do not retry)
 *   500 — event processing error (Stripe WILL retry)
 *   200 — event handled or intentionally ignored
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type Stripe from "stripe";
import { eq, and } from "drizzle-orm";
import type { Db, StripeClient } from "./context";
import { orders, stores, processedStripeEvents } from "./db/schema";
import { markOrderPaid } from "./db/order-transitions";

// ---------------------------------------------------------------------------
// HTTP-level handler — collects raw body, verifies signature, dispatches
// ---------------------------------------------------------------------------

export function handleStripeWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    db: Db;
    stripe: Pick<StripeClient, "retrieveAccountStatus">;
    /**
     * One signing secret per Stripe webhook destination. For a Connect platform
     * there are two destinations — the platform ("Your account") and the
     * connected-accounts endpoint — each with its own `whsec_…` secret.
     * Verification tries each secret in order; the first that succeeds wins.
     * Only when ALL secrets fail does the request return 400.
     */
    webhookSecrets: string[];
    constructWebhookEvent: (
      rawBody: Buffer,
      signature: string,
      webhookSecret: string,
    ) => Stripe.Event;
  },
): void {
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    const rawBody = Buffer.concat(chunks);
    const sig = req.headers["stripe-signature"];

    if (typeof sig !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing stripe-signature header" }));
      return;
    }

    // Try each signing secret in turn. The first that verifies wins.
    // Only if every secret throws do we return 400 (same semantics as before,
    // just extended to multiple destinations).
    let event: Stripe.Event | undefined;
    let lastError: string = "Signature verification failed";
    for (const secret of opts.webhookSecrets) {
      try {
        event = opts.constructWebhookEvent(rawBody, sig, secret);
        break; // verified — stop trying
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Signature verification failed";
        // continue to next secret
      }
    }

    if (!event) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: lastError }));
      return;
    }

    // Capture in a const so TypeScript knows it's non-null inside the async callbacks.
    const verifiedEvent = event;

    // Dispatch; respond 500 on processing errors so Stripe retries delivery.
    handleStripeEvent(verifiedEvent, { db: opts.db, stripe: opts.stripe })
      .then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      })
      .catch((err: unknown) => {
        console.error(
          "[webhook] error processing event",
          verifiedEvent.type,
          err instanceof Error ? err.message : String(err),
        );
        // 500 tells Stripe the event was not processed — it will retry.
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Event processing failed" }));
      });
  });

  req.on("error", (err) => {
    console.error("[webhook] request read error", err instanceof Error ? err.message : String(err));
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to read request body" }));
  });
}

// ---------------------------------------------------------------------------
// Pure event dispatcher — unit-testable
// ---------------------------------------------------------------------------

export async function handleStripeEvent(
  event: Stripe.Event,
  deps: { db: Db; stripe: Pick<StripeClient, "retrieveAccountStatus"> },
): Promise<void> {
  const { db, stripe } = deps;

  // Pre-fetch any external data a handler needs BEFORE opening the DB transaction.
  // No network I/O may occur while a pooled DB connection/transaction is held —
  // doing so risks pool exhaustion under load or Stripe latency spikes.
  //
  // A duplicate account.updated event makes one wasted Stripe read before the
  // dedup claim reveals it's a dup — acceptable; duplicates are rare and
  // correctness is fully preserved (claim + write still commit atomically).
  let accountStatus:
    | { chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }
    | undefined;
  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    // Do NOT blind-write the webhook payload — Stripe delivers events
    // asynchronously and out-of-order delivery would corrupt the flags.
    // Always re-read the authoritative state from the Stripe API.
    accountStatus = await stripe.retrieveAccountStatus(account.id);
  }

  // Wrap the ENTIRE dispatch in a single DB transaction that first claims the
  // event id. If the claim INSERT returns no rows the event is a duplicate and
  // we exit without side effects (exactly-once semantics). A crash mid-handler
  // rolls back the claim so Stripe's retry will reprocess.
  await db.transaction(async (tx) => {
    const claimed = await tx
      .insert(processedStripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: processedStripeEvents.id });

    if (claimed.length === 0) {
      // Already processed — skip (exactly-once).
      return;
    }

    // All DB operations inside the switch use `tx` (not `db`) so the side
    // effect and the claim commit atomically together.
    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;
        // Idempotent: only transition pending_payment → paid.
        // Re-delivery of an already-paid event is a no-op (markOrderPaid returns false).
        await markOrderPaid(tx, pi.id);
        break;
      }

      case "payment_intent.canceled": {
        const pi = event.data.object as Stripe.PaymentIntent;
        // Terminal transition: pending_payment → cancelled.
        // Only cancels if the order is still in pending_payment; already-terminal
        // orders are unaffected (idempotent).
        await tx
          .update(orders)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(
            and(
              eq(orders.stripePaymentIntentId, pi.id),
              eq(orders.status, "pending_payment"),
            ),
          );
        break;
      }

      case "payment_intent.payment_failed": {
        // No status change — leave the order in its current state.
        // The buyer can retry via the client secret or the seller can cancel.
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        // Guard the nullable payment_intent field — a charge without a PI is
        // not an order charge we track.
        if (!charge.payment_intent) break;

        const piId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : charge.payment_intent.id;

        const isFullRefund = charge.amount_refunded >= charge.amount;

        await tx
          .update(orders)
          .set({
            refundedCents: charge.amount_refunded,
            ...(isFullRefund ? { status: "refunded" as const, updatedAt: new Date() } : { updatedAt: new Date() }),
          })
          .where(eq(orders.stripePaymentIntentId, piId));
        break;
      }

      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        // Guard the nullable payment_intent field.
        if (!dispute.payment_intent) break;

        const piId =
          typeof dispute.payment_intent === "string"
            ? dispute.payment_intent
            : dispute.payment_intent.id;

        await tx
          .update(orders)
          .set({ status: "disputed", updatedAt: new Date() })
          .where(eq(orders.stripePaymentIntentId, piId));
        break;
      }

      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        // accountStatus was fetched before the transaction opened (see above).
        // The non-null assertion is safe: this branch is only reached when
        // event.type === "account.updated", which is exactly when accountStatus
        // was populated.
        await tx
          .update(stores)
          .set({
            chargesEnabled: accountStatus!.chargesEnabled,
            payoutsEnabled: accountStatus!.payoutsEnabled,
            detailsSubmitted: accountStatus!.detailsSubmitted,
          })
          .where(eq(stores.stripeConnectAccountId, account.id));
        break;
      }

      default:
        // Unknown event type — ignore silently; Stripe expects 200.
        break;
    }
  });
}
