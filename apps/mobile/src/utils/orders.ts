/**
 * Shared order-level helpers used across mobile screens.
 * Types come from @homegrown/shared — never redeclared here.
 */

import type { Order } from "@homegrown/shared";

/**
 * Returns true when an order has an outstanding refund request that the seller
 * has not yet approved or declined.
 */
export function isPendingRefund(o: Order): boolean {
  return (
    o.refundRequestedAt != null &&
    o.refundApprovedAt == null &&
    o.refundDeclinedAt == null
  );
}
