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
 * Event dispatch:
 *   payment_intent.succeeded   → set order status pending_payment → paid (idempotent)
 *   payment_intent.payment_failed → no-op (leave status as-is)
 *   account.updated             → sync store's chargesEnabled / payoutsEnabled / detailsSubmitted
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
import type { Db } from "./context";
import { orders, stores } from "./db/schema";

// ---------------------------------------------------------------------------
// HTTP-level handler — collects raw body, verifies signature, dispatches
// ---------------------------------------------------------------------------

export function handleStripeWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    db: Db;
    webhookSecret: string;
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

    let event: Stripe.Event;
    try {
      event = opts.constructWebhookEvent(rawBody, sig, opts.webhookSecret);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Signature verification failed";
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return;
    }

    // Dispatch; respond 500 on processing errors so Stripe retries delivery.
    handleStripeEvent(event, opts.db)
      .then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      })
      .catch((err: unknown) => {
        console.error(
          "[webhook] error processing event",
          event.type,
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

export async function handleStripeEvent(event: Stripe.Event, db: Db): Promise<void> {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      // Idempotent: only transition pending_payment → paid.
      // Re-delivery of an already-paid event is a no-op.
      await db
        .update(orders)
        .set({ status: "paid", updatedAt: new Date() })
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

    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      await db
        .update(stores)
        .set({
          chargesEnabled: account.charges_enabled ?? false,
          payoutsEnabled: account.payouts_enabled ?? false,
          detailsSubmitted: account.details_submitted ?? false,
        })
        .where(eq(stores.stripeConnectAccountId, account.id));
      break;
    }

    default:
      // Unknown event type — ignore silently; Stripe expects 200.
      break;
  }
}
