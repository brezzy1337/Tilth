/**
 * Stripe reconciliation poller — pure, dependency-injected, unit-testable.
 *
 * This module contains NO process.env reads, no DB connection setup, and no
 * Stripe SDK construction. All side-effectful dependencies are injected via the
 * `deps` parameter — exactly like the split between `env.schema.ts` (pure) and
 * `env.ts` (side effects).
 *
 * Two reconciliation passes per run:
 *
 * 1. Onboarding resync (P0 fix):
 *    Selects stores that have a stripeConnectAccountId but are not yet fully
 *    enabled (chargesEnabled=false OR payoutsEnabled=false OR
 *    detailsSubmitted=false). For each, reads the authoritative state from Stripe
 *    and updates the row if any flag differs. This unblocks orders.create for
 *    sellers who completed onboarding but whose account.updated event was dropped
 *    (because the connected-account webhook was not wired).
 *
 * 2. Stale pending-payment reconcile:
 *    Selects orders stuck in pending_payment for longer than `staleAfterMinutes`
 *    (default 10) that have a stripePaymentIntentId. For each, reads the PI
 *    status from Stripe; if succeeded, performs the same idempotent transition
 *    the webhook uses (pending_payment → paid). This recovers payments where the
 *    payment_intent.succeeded webhook was missed or not yet delivered.
 *
 * Resilience: a single failing Stripe API call never aborts the whole run.
 * Errors are logged and counted; the function always returns a summary.
 */

import { and, eq, isNotNull, or, lt, sql } from "drizzle-orm";
import type { Db, StripeClient } from "../context";
import { stores, orders } from "../db/schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReconcileSummary {
  storesChecked: number;
  storesUpdated: number;
  ordersChecked: number;
  ordersMarkedPaid: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function reconcile(deps: {
  db: Db;
  stripe: Pick<StripeClient, "retrieveAccountStatus" | "retrievePaymentIntent">;
  staleAfterMinutes?: number;
}): Promise<ReconcileSummary> {
  const { db, stripe, staleAfterMinutes = 10 } = deps;

  const summary: ReconcileSummary = {
    storesChecked: 0,
    storesUpdated: 0,
    ordersChecked: 0,
    ordersMarkedPaid: 0,
    errors: 0,
  };

  // ---------------------------------------------------------------------------
  // Pass 1: Onboarding resync — THE P0 FIX
  // ---------------------------------------------------------------------------
  // Select stores that have a Connect account id but are not yet fully enabled.
  // At least one of the three flags is still false, meaning account.updated was
  // either never delivered or was delivered to the wrong webhook destination.
  const staleStores = await db
    .select({
      id: stores.id,
      stripeConnectAccountId: stores.stripeConnectAccountId,
      chargesEnabled: stores.chargesEnabled,
      payoutsEnabled: stores.payoutsEnabled,
      detailsSubmitted: stores.detailsSubmitted,
    })
    .from(stores)
    .where(
      and(
        isNotNull(stores.stripeConnectAccountId),
        or(
          eq(stores.chargesEnabled, false),
          eq(stores.payoutsEnabled, false),
          eq(stores.detailsSubmitted, false),
        ),
      ),
    );

  summary.storesChecked = staleStores.length;

  for (const store of staleStores) {
    // stripeConnectAccountId is guaranteed non-null by the query above,
    // but TypeScript sees it as string | null from the schema. Assert here.
    const acctId = store.stripeConnectAccountId!;

    try {
      const acctStatus = await stripe.retrieveAccountStatus(acctId);

      const anyDiffers =
        acctStatus.chargesEnabled !== store.chargesEnabled ||
        acctStatus.payoutsEnabled !== store.payoutsEnabled ||
        acctStatus.detailsSubmitted !== store.detailsSubmitted;

      if (anyDiffers) {
        await db
          .update(stores)
          .set({
            chargesEnabled: acctStatus.chargesEnabled,
            payoutsEnabled: acctStatus.payoutsEnabled,
            detailsSubmitted: acctStatus.detailsSubmitted,
          })
          .where(eq(stores.id, store.id));

        summary.storesUpdated++;
      }
    } catch (err) {
      console.error(
        "[reconcile] retrieveAccountStatus failed for store",
        store.id,
        "account",
        acctId,
        err instanceof Error ? err.message : String(err),
      );
      summary.errors++;
    }
  }

  // ---------------------------------------------------------------------------
  // Pass 2: Stale pending-payment reconcile
  // ---------------------------------------------------------------------------
  // Select orders stuck in pending_payment with a PI that's older than the
  // stale threshold. The comparison is done in SQL to avoid timezone drift.
  const cutoff = sql`now() - make_interval(mins => ${staleAfterMinutes})`;

  const staleOrders = await db
    .select({
      id: orders.id,
      stripePaymentIntentId: orders.stripePaymentIntentId,
    })
    .from(orders)
    .where(
      and(
        eq(orders.status, "pending_payment"),
        isNotNull(orders.stripePaymentIntentId),
        lt(orders.createdAt, cutoff),
      ),
    );

  summary.ordersChecked = staleOrders.length;

  for (const order of staleOrders) {
    // stripePaymentIntentId is guaranteed non-null by the query above.
    const piId = order.stripePaymentIntentId!;

    try {
      const pi = await stripe.retrievePaymentIntent(piId);

      if (pi.status === "succeeded") {
        // Mirror the idempotent transition from webhook.ts payment_intent.succeeded:
        // UPDATE orders SET status='paid', updatedAt=now()
        // WHERE stripePaymentIntentId = ? AND status = 'pending_payment'
        // The WHERE status guard makes this safe to re-run — already-paid rows are skipped.
        await db
          .update(orders)
          .set({ status: "paid", updatedAt: new Date() })
          .where(
            and(
              eq(orders.stripePaymentIntentId, piId),
              eq(orders.status, "pending_payment"),
            ),
          );

        summary.ordersMarkedPaid++;
      }
      // All other PI statuses (requires_payment_method, processing, canceled, etc.)
      // are left as-is — the buyer can retry or the seller can cancel.
    } catch (err) {
      console.error(
        "[reconcile] retrievePaymentIntent failed for order",
        order.id,
        "pi",
        piId,
        err instanceof Error ? err.message : String(err),
      );
      summary.errors++;
    }
  }

  return summary;
}
