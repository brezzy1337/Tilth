/**
 * Shared order-state transition helpers.
 *
 * Extracted here so the same idempotent logic can be used by both the webhook
 * handler and the reconciliation poller — avoiding the PR1 overcount where
 * reconcile incremented ordersMarkedPaid even when the row was already paid.
 *
 * All helpers accept either a raw `Db` or a Drizzle transaction handle so they
 * compose cleanly inside db.transaction(async (tx) => …) blocks.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "../context";
import { orders } from "./schema";

/**
 * DbOrTx — a `Db` instance or a Drizzle postgres-js transaction handle.
 *
 * `Parameters<Parameters<Db["transaction"]>[0]>[0]` extracts the type of the
 * first argument that the callback passed to `db.transaction()` receives — i.e.
 * the transaction object `tx`.  Unioning with `Db` lets helpers accept both.
 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Idempotent `pending_payment → paid` transition.
 *
 * Runs:
 *   UPDATE orders
 *   SET status = 'paid', updatedAt = now()
 *   WHERE stripePaymentIntentId = piId
 *     AND status = 'pending_payment'
 *
 * The `status = 'pending_payment'` guard makes re-delivery safe: if the row is
 * already paid (or in any other terminal state) the WHERE clause matches nothing
 * and the function returns false.
 *
 * @param dbOrTx  DB or transaction handle — callers inside a transaction pass `tx`.
 * @param piId    Stripe PaymentIntent id (e.g. "pi_…").
 * @returns       `true` if a row actually transitioned; `false` if it was already
 *                in a non-pending state (duplicate delivery / re-run).
 */
export async function markOrderPaid(dbOrTx: DbOrTx, piId: string): Promise<boolean> {
  const result = await (dbOrTx as Db)
    .update(orders)
    .set({ status: "paid", updatedAt: new Date() })
    .where(
      and(
        eq(orders.stripePaymentIntentId, piId),
        eq(orders.status, "pending_payment"),
      ),
    )
    .returning({ id: orders.id });

  // With .returning(), Drizzle + postgres-js populates the result array only for
  // rows that were actually updated. An empty array means the WHERE clause matched
  // nothing (order was already in a terminal state — idempotent re-delivery).
  return result.length > 0;
}
