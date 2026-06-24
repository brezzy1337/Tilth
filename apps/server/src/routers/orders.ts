/**
 * Orders router — M4 Payments backbone.
 *
 * `create`        — protected; builds an order from listing ids, creates a Stripe
 *                   destination-charge PaymentIntent, returns the clientSecret.
 * `listMine`      — protected; returns the authenticated buyer's orders, newest first.
 * `get`           — protected; returns a single order (caller must be buyer or store owner).
 * `requestRefund` — protected; buyer requests a refund (sets refundRequestedAt).
 * `approveRefund` — protected; store owner approves a refund request (calls Stripe).
 * `declineRefund` — protected; store owner declines a refund request (no Stripe call).
 * `listForMyStore`— protected; returns paginated orders for the caller's store, newest first.
 *
 * Rules that must hold here:
 *   - No imports of env, db/index, or the Stripe SDK — everything via ctx.
 *   - Money is ALWAYS integer cents; never floats.
 *   - Price is read from the LISTING server-side (never trust client-supplied prices).
 *   - Payment state truth comes from Stripe webhooks, not client-reported success.
 */

import { TRPCError } from "@trpc/server";
import {
  createOrderInput,
  createOrderResponse,
  requestRefundInput,
  approveRefundInput,
  declineRefundInput,
  markFulfilledInput,
  listForMyStoreInput,
  listForMyStoreOutput,
  order as orderSchema,
  type Order,
  type OrderItemOutput,
} from "@homegrown/shared";
import { z } from "zod";
import { eq, inArray, desc, and, isNull, isNotNull, lt, or } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc";
import { orders, orderItems, listings, stores } from "../db/schema";
import type { Db } from "../context";

/**
 * Platform fee in basis points (1 bp = 0.01%).
 * 1000 bps = 10% — HomeGrown's pilot rate.
 * Withheld from the seller's transfer via `application_fee_amount` on the destination charge.
 */
const PLATFORM_FEE_BPS = 1000;

// ---------------------------------------------------------------------------
// Shared column projections — single source of truth for the select shape
// ---------------------------------------------------------------------------

/**
 * The 14-field orders projection used by all select() calls.
 * Add new order columns here; mapOrder and loadOrderById stay in sync automatically.
 */
const orderColumns = {
  id: orders.id,
  storeId: orders.storeId,
  buyerId: orders.buyerId,
  status: orders.status,
  subtotalCents: orders.subtotalCents,
  applicationFeeCents: orders.applicationFeeCents,
  totalCents: orders.totalCents,
  stripePaymentIntentId: orders.stripePaymentIntentId,
  fulfillmentMethod: orders.fulfillmentMethod,
  deliveryAddress: orders.deliveryAddress,
  refundRequestedAt: orders.refundRequestedAt,
  refundReason: orders.refundReason,
  refundApprovedAt: orders.refundApprovedAt,
  refundDeclinedAt: orders.refundDeclinedAt,
  createdAt: orders.createdAt,
  updatedAt: orders.updatedAt,
} as const;

// ---------------------------------------------------------------------------
// Cursor codec — base64 keyset cursor for listForMyStore pagination
// ---------------------------------------------------------------------------

/**
 * Encode a (createdAt, id) pair as an opaque base64 cursor string.
 * The payload is always ASCII (ISO date + UUID) so btoa is safe.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return btoa(`${createdAt.toISOString()}|${id}`);
}

/**
 * Decode an opaque cursor back to (createdAt, id).
 * Validates the id with z.string().uuid() and the date with !isNaN(getTime()).
 * Throws TRPCError BAD_REQUEST "Invalid cursor" on any malformed part.
 */
function decodeCursor(raw: string): { createdAt: Date; id: string } {
  try {
    const decoded = atob(raw);
    const sepIdx = decoded.indexOf("|");
    if (sepIdx === -1) throw new Error("missing separator");
    const dateStr = decoded.slice(0, sepIdx);
    const id = decoded.slice(sepIdx + 1);
    const parsedDate = new Date(dateStr);
    if (isNaN(parsedDate.getTime())) throw new Error("bad date");
    // Validate id is a valid UUID
    z.string().uuid().parse(id);
    return { createdAt: parsedDate, id };
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
}

/**
 * Extends orderColumns with `storeUserId` for procedures that join stores.
 * Used in `get`, `approveRefund`, `declineRefund`.
 */
const orderColumnsWithStore = {
  ...orderColumns,
  storeUserId: stores.userId,
} as const;

/**
 * The 6-field orderItems projection used for single-order fetches
 * (`loadOrderById`, `get`). No orderId included — query already scopes to one order.
 */
const itemColumns = {
  id: orderItems.id,
  listingId: orderItems.listingId,
  nameSnapshot: orderItems.nameSnapshot,
  unitPriceCents: orderItems.unitPriceCents,
  quantity: orderItems.quantity,
  lineTotalCents: orderItems.lineTotalCents,
} as const;

/**
 * Extends itemColumns with `orderId` for multi-order fetches that group items
 * by order id (`listMine`, `listForMyStore`).
 */
const itemColumnsWithOrderId = {
  ...itemColumns,
  orderId: orderItems.orderId,
} as const;

// ---------------------------------------------------------------------------
// Private output mappers — keep the DB-row → shared-type transformation DRY
// ---------------------------------------------------------------------------

function mapOrderItem(row: {
  id: string;
  listingId: string;
  nameSnapshot: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}): OrderItemOutput {
  return {
    id: row.id,
    listingId: row.listingId,
    nameSnapshot: row.nameSnapshot,
    unitPriceCents: row.unitPriceCents,
    quantity: row.quantity,
    lineTotalCents: row.lineTotalCents,
  };
}

function mapOrder(
  orderRow: {
    id: string;
    storeId: string;
    buyerId: string;
    status: Order["status"];
    subtotalCents: number;
    applicationFeeCents: number;
    totalCents: number;
    stripePaymentIntentId: string | null;
    fulfillmentMethod: Order["fulfillmentMethod"];
    deliveryAddress: string | null;
    refundRequestedAt: Date | null;
    refundReason: string | null;
    refundApprovedAt: Date | null;
    refundDeclinedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  itemRows: Parameters<typeof mapOrderItem>[0][],
): Order {
  return {
    id: orderRow.id,
    storeId: orderRow.storeId,
    buyerId: orderRow.buyerId,
    status: orderRow.status,
    subtotalCents: orderRow.subtotalCents,
    applicationFeeCents: orderRow.applicationFeeCents,
    totalCents: orderRow.totalCents,
    stripePaymentIntentId: orderRow.stripePaymentIntentId ?? null,
    fulfillmentMethod: orderRow.fulfillmentMethod,
    deliveryAddress: orderRow.deliveryAddress ?? null,
    refundRequestedAt: orderRow.refundRequestedAt?.toISOString() ?? null,
    refundReason: orderRow.refundReason ?? null,
    refundApprovedAt: orderRow.refundApprovedAt?.toISOString() ?? null,
    refundDeclinedAt: orderRow.refundDeclinedAt?.toISOString() ?? null,
    items: itemRows.map(mapOrderItem),
    createdAt: orderRow.createdAt.toISOString(),
    updatedAt: orderRow.updatedAt.toISOString(),
  };
}

/**
 * Load a single order by id plus its items, and return the mapped Order DTO.
 * Throws NOT_FOUND if the order does not exist.
 * Used as the authoritative post-mutation re-fetch in requestRefund, approveRefund,
 * and declineRefund so that each procedure returns the actual committed state.
 */
async function loadOrderById(db: Db, orderId: string): Promise<Order> {
  const [row] = await db
    .select(orderColumns)
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!row) {
    // loadOrderById is only called immediately after a successful, ownership-checked
    // mutation, so a missing row here is a server-side integrity failure (the row was
    // just updated), not a client "not found". Surface 500, matching pre-refactor behavior.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to load order after update",
    });
  }

  const fetchedItems = await db
    .select(itemColumns)
    .from(orderItems)
    .where(eq(orderItems.orderId, row.id));

  return mapOrder(row, fetchedItems);
}

export const ordersRouter = router({
  /**
   * Create an order from a list of listing ids + quantities.
   *
   * Server-side price computation (never trust client prices):
   *   lineTotal   = listing.priceCents × quantity
   *   subtotal    = Σ lineTotal
   *   appFee      = round(subtotal × PLATFORM_FEE_BPS / 10000)   ← 10% pilot
   *   total       = subtotal  (buyer pays subtotal; fee is withheld from seller)
   *
   * All items must belong to ONE store (marketplace constraint for this pilot).
   * The store must have a stripeConnectAccountId and chargesEnabled = true.
   */
  create: protectedProcedure
    .input(createOrderInput)
    .output(createOrderResponse)
    .mutation(async ({ input, ctx }) => {
      // Server-side re-validation of the delivery address requirement.
      // The shared zod schema already enforces this via .refine(), but we guard
      // again here so the check happens BEFORE any DB insert or Stripe call —
      // preventing orphaned PaymentIntents if the shared schema is ever relaxed.
      if (input.fulfillmentMethod === "delivery" && !input.deliveryAddress?.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Delivery address is required for delivery",
        });
      }

      // Normalise: pickup orders never store a delivery address.
      const deliveryAddress =
        input.fulfillmentMethod === "delivery" ? (input.deliveryAddress ?? null) : null;

      const listingIds = input.items.map((i) => i.listingId);

      // Fetch all listings in one query
      const fetchedListings = await ctx.db
        .select({
          id: listings.id,
          storeId: listings.storeId,
          name: listings.name,
          priceCents: listings.priceCents,
        })
        .from(listings)
        .where(inArray(listings.id, listingIds));

      // Verify all requested listings exist
      if (fetchedListings.length !== listingIds.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "One or more listings not found",
        });
      }

      // Enforce single-store constraint
      const storeIds = [...new Set(fetchedListings.map((l) => l.storeId))];
      if (storeIds.length > 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "All items must be from one store",
        });
      }

      const storeId = storeIds[0]!;

      // Load the store — need stripeConnectAccountId and chargesEnabled
      const [store] = await ctx.db
        .select({
          id: stores.id,
          stripeConnectAccountId: stores.stripeConnectAccountId,
          chargesEnabled: stores.chargesEnabled,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);

      if (!store) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Store not found",
        });
      }

      if (!store.stripeConnectAccountId || !store.chargesEnabled) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This seller isn't set up to accept payments yet",
        });
      }

      // Build a lookup map for server-side price computation
      const listingMap = new Map(fetchedListings.map((l) => [l.id, l]));

      // Compute line totals using LISTING prices (never trust client-supplied prices)
      const lines = input.items.map((item) => {
        const listing = listingMap.get(item.listingId)!;
        const lineTotalCents = listing.priceCents * item.quantity;
        return {
          listingId: item.listingId,
          nameSnapshot: listing.name,
          unitPriceCents: listing.priceCents,
          quantity: item.quantity,
          lineTotalCents,
        };
      });

      const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
      const applicationFeeCents = Math.round((subtotalCents * PLATFORM_FEE_BPS) / 10000);
      // Buyer pays the subtotal; the platform fee is withheld from the seller's transfer
      const totalCents = subtotalCents;

      // Insert order + items in a transaction
      let orderId: string;
      let insertedItems: Array<{
        id: string;
        listingId: string;
        nameSnapshot: string;
        unitPriceCents: number;
        quantity: number;
        lineTotalCents: number;
      }>;

      try {
        const result = await ctx.db.transaction(async (tx) => {
          // Insert order
          const [newOrder] = await tx
            .insert(orders)
            .values({
              storeId,
              buyerId: ctx.user.id,
              status: "pending_payment",
              subtotalCents,
              applicationFeeCents,
              totalCents,
              fulfillmentMethod: input.fulfillmentMethod,
              deliveryAddress,
            })
            .returning({ id: orders.id });

          if (!newOrder) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to create order",
            });
          }

          // Insert order items
          const newItems = await tx
            .insert(orderItems)
            .values(
              lines.map((l) => ({
                orderId: newOrder.id,
                listingId: l.listingId,
                nameSnapshot: l.nameSnapshot,
                unitPriceCents: l.unitPriceCents,
                quantity: l.quantity,
                lineTotalCents: l.lineTotalCents,
              })),
            )
            .returning({
              id: orderItems.id,
              listingId: orderItems.listingId,
              nameSnapshot: orderItems.nameSnapshot,
              unitPriceCents: orderItems.unitPriceCents,
              quantity: orderItems.quantity,
              lineTotalCents: orderItems.lineTotalCents,
            });

          return { orderId: newOrder.id, items: newItems };
        });

        orderId = result.orderId;
        insertedItems = result.items;
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create order",
          cause: err,
        });
      }

      // Create the Stripe PaymentIntent (destination charge)
      let clientSecret: string;
      let paymentIntentId: string;
      try {
        // idempotencyKey = orderId: stable for the lifetime of this request, so the Stripe SDK's
        // network retries (maxNetworkRetries) and any server-side re-invocation with the same
        // orderId are de-duplicated by Stripe. It does NOT dedupe across separate client retries
        // of orders.create — those mint a new orderId (defaultRandom) and produce a new key.
        const pi = await ctx.stripe.createPaymentIntent({
          amountCents: totalCents,
          applicationFeeCents,
          destinationAccountId: store.stripeConnectAccountId,
          metadata: { orderId },
          idempotencyKey: orderId,
        });
        clientSecret = pi.clientSecret;
        paymentIntentId = pi.id;
      } catch (err) {
        // Log the error server-side (no cause attached — key-leak hardening)
        console.error(
          "[orders.create] payment intent failed",
          err instanceof Error ? err.message : String(err),
        );

        // Stripe call failed — cancel the order so it doesn't linger as pending_payment
        await ctx.db
          .update(orders)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(orders.id, orderId));

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create payment intent",
        });
      }

      // Persist the PaymentIntent id for webhook dispatch.
      // If this update fails the order is stuck pending_payment with no PI id the
      // webhook can never match — so we cancel and surface an error.
      const now = new Date();
      try {
        await ctx.db
          .update(orders)
          .set({ stripePaymentIntentId: paymentIntentId, updatedAt: now })
          .where(eq(orders.id, orderId));
      } catch (err) {
        console.error(
          "[orders.create] failed to persist payment intent id",
          err instanceof Error ? err.message : String(err),
        );

        // Cancel the order so it is not stuck in an unmatchable pending_payment state
        await ctx.db
          .update(orders)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(orders.id, orderId));

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to persist payment intent; order has been cancelled",
        });
      }

      const orderRow = {
        id: orderId,
        storeId,
        buyerId: ctx.user.id,
        status: "pending_payment" as const,
        subtotalCents,
        applicationFeeCents,
        totalCents,
        stripePaymentIntentId: paymentIntentId,
        fulfillmentMethod: input.fulfillmentMethod,
        deliveryAddress,
        refundRequestedAt: null,
        refundReason: null,
        refundApprovedAt: null,
        refundDeclinedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      return { order: mapOrder(orderRow, insertedItems), clientSecret };
    }),

  /**
   * List the authenticated buyer's orders, newest first.
   */
  listMine: protectedProcedure
    .output(orderSchema.array())
    .query(async ({ ctx }) => {
      const myOrders = await ctx.db
        .select(orderColumns)
        .from(orders)
        .where(eq(orders.buyerId, ctx.user.id))
        .orderBy(desc(orders.createdAt));

      if (myOrders.length === 0) return [];

      const orderIds = myOrders.map((o) => o.id);
      const allItems = await ctx.db
        .select(itemColumnsWithOrderId)
        .from(orderItems)
        .where(inArray(orderItems.orderId, orderIds));

      const itemsByOrder = new Map<string, typeof allItems>();
      for (const item of allItems) {
        const list = itemsByOrder.get(item.orderId) ?? [];
        list.push(item);
        itemsByOrder.set(item.orderId, list);
      }

      return myOrders.map((o) =>
        mapOrder(o, itemsByOrder.get(o.id) ?? []),
      );
    }),

  /**
   * Get a single order by id.
   * Caller must be the buyer or the owner of the order's store.
   */
  get: protectedProcedure
    .input(orderSchema.pick({ id: true }))
    .output(orderSchema)
    .query(async ({ input, ctx }) => {
      const [foundOrder] = await ctx.db
        .select(orderColumnsWithStore)
        .from(orders)
        .innerJoin(stores, eq(orders.storeId, stores.id))
        .where(eq(orders.id, input.id))
        .limit(1);

      if (!foundOrder) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }

      // Authorization: caller must be buyer or store owner
      const isBuyer = foundOrder.buyerId === ctx.user.id;
      const isStoreOwner = foundOrder.storeUserId === ctx.user.id;
      if (!isBuyer && !isStoreOwner) {
        // Surface as NOT_FOUND to avoid leaking order existence
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }

      const fetchedItems = await ctx.db
        .select(itemColumns)
        .from(orderItems)
        .where(eq(orderItems.orderId, foundOrder.id));

      return mapOrder(foundOrder, fetchedItems);
    }),

  /**
   * Request a refund for an order (BUYER only).
   *
   * Asserts:
   *   - Caller is the buyer (else NOT_FOUND to avoid leaking order existence).
   *   - Status is 'paid' or 'fulfilled' (else BAD_REQUEST).
   *   - No refund has been requested yet (else BAD_REQUEST).
   *
   * Sets refund_requested_at = now(), refund_reason = input.reason (nullable),
   * and clears refund_declined_at (so the buyer can re-request after a decline).
   * Does NOT call Stripe — that happens in approveRefund.
   *
   * The UPDATE WHERE clause includes `isNull(orders.refundRequestedAt)` to guard
   * against a concurrent re-request race; a 0-row result means the request was
   * already submitted and surfaces as BAD_REQUEST.
   */
  requestRefund: protectedProcedure
    .input(requestRefundInput)
    .output(orderSchema)
    .mutation(async ({ input, ctx }) => {
      const [foundOrder] = await ctx.db
        .select(orderColumns)
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);

      // Surface as NOT_FOUND when not found or caller is not the buyer
      if (!foundOrder || foundOrder.buyerId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }

      if (foundOrder.status !== "paid" && foundOrder.status !== "fulfilled") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only paid or fulfilled orders can be refunded",
        });
      }

      if (foundOrder.refundRequestedAt !== null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Refund already requested",
        });
      }

      const now = new Date();
      // Guard: also include isNull(refundRequestedAt) in the WHERE to defend against
      // a concurrent re-request race (two simultaneous calls both pass the pre-check
      // read, but only one can win the guarded UPDATE).
      const claimed = await ctx.db
        .update(orders)
        .set({
          refundRequestedAt: now,
          refundReason: input.reason ?? null,
          refundDeclinedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(orders.id, input.orderId),
            eq(orders.buyerId, ctx.user.id),
            isNull(orders.refundRequestedAt),
          ),
        )
        .returning({ id: orders.id });

      if (claimed.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Refund already requested",
        });
      }

      return loadOrderById(ctx.db, input.orderId);
    }),

  /**
   * Approve a refund request (SELLER / store owner only).
   *
   * Uses an atomic claim UPDATE to prevent approve↔decline races:
   *   UPDATE orders SET refundApprovedAt = now() WHERE id = ? AND storeId = ?
   *     AND refundRequestedAt IS NOT NULL AND refundApprovedAt IS NULL
   *     AND refundDeclinedAt IS NULL RETURNING { id }
   *
   * Only the claim winner calls Stripe. On Stripe failure, the claim is reverted
   * (refundApprovedAt set back to NULL) so the operation is retryable; the stable
   * idempotency key ensures a retried Stripe call is a no-op.
   *
   * Does NOT set status='refunded' — the charge.refunded webhook is the source of truth.
   */
  approveRefund: protectedProcedure
    .input(approveRefundInput)
    .output(orderSchema)
    .mutation(async ({ input, ctx }) => {
      const orderId = input.orderId;

      // Load order + store for ownership check and to read stripePaymentIntentId
      const [foundOrder] = await ctx.db
        .select(orderColumnsWithStore)
        .from(orders)
        .innerJoin(stores, eq(orders.storeId, stores.id))
        .where(eq(orders.id, orderId))
        .limit(1);

      // Surface as NOT_FOUND when not found or caller is not the store owner
      if (!foundOrder || foundOrder.storeUserId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }

      if (!foundOrder.stripePaymentIntentId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Order has no payment intent; cannot refund",
        });
      }

      // Pre-check: surface a precise error before the atomic claim so the caller
      // gets an informative message even when the read→check→claim is non-atomic.
      // The claim itself is the real race-safety mechanism.
      if (foundOrder.status !== "paid" && foundOrder.status !== "fulfilled") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only paid or fulfilled orders can be refunded",
        });
      }

      if (foundOrder.refundRequestedAt === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No refund requested for this order",
        });
      }

      const paymentIntentId = foundOrder.stripePaymentIntentId;

      // Atomic claim: exactly one concurrent caller wins this UPDATE.
      // Guards: status IN (paid, fulfilled) AND refundRequestedAt IS NOT NULL
      //         AND refundApprovedAt IS NULL AND refundDeclinedAt IS NULL
      // The status condition is included atomically so a concurrent webhook that moves
      // the order to 'refunded' or 'disputed' cannot be double-refunded.
      const claimNow = new Date();
      const claimed = await ctx.db
        .update(orders)
        .set({ refundApprovedAt: claimNow, updatedAt: claimNow })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, foundOrder.storeId),
            or(eq(orders.status, "paid"), eq(orders.status, "fulfilled")),
            isNotNull(orders.refundRequestedAt),
            isNull(orders.refundApprovedAt),
            isNull(orders.refundDeclinedAt),
          ),
        )
        .returning({ id: orders.id });

      if (claimed.length === 0) {
        // Re-read to give a precise error message
        const [current] = await ctx.db
          .select({
            refundApprovedAt: orders.refundApprovedAt,
            refundDeclinedAt: orders.refundDeclinedAt,
            refundRequestedAt: orders.refundRequestedAt,
          })
          .from(orders)
          .where(eq(orders.id, orderId))
          .limit(1);

        if (current?.refundApprovedAt !== null && current?.refundApprovedAt !== undefined) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Refund already approved" });
        }
        if (current?.refundDeclinedAt !== null && current?.refundDeclinedAt !== undefined) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Refund already declined" });
        }
        throw new TRPCError({ code: "BAD_REQUEST", message: "No refund requested for this order" });
      }

      // Claim won — call Stripe. On failure, revert the claim so the operation is retryable.
      try {
        await ctx.stripe.refundPayment({
          paymentIntentId,
          idempotencyKey: `refund-${orderId}`,
        });
      } catch (err) {
        // Revert the claim: clear refundApprovedAt so a retry can re-enter the claim path.
        // Scoped to the exact timestamp this call set so a concurrent caller's claim is
        // never accidentally cleared. The stable idempotency key makes a retried Stripe call
        // a no-op if the first actually succeeded despite throwing (network timeout, etc.).
        // Edge case: if Stripe timed out but actually processed the refund, the
        // charge.refunded webhook will arrive and set status='refunded'; the restored
        // status gate (above) will then block any subsequent re-claim, self-healing the race.
        await ctx.db
          .update(orders)
          .set({ refundApprovedAt: null, updatedAt: new Date() })
          .where(and(eq(orders.id, orderId), eq(orders.refundApprovedAt, claimNow)));
        throw err;
      }

      return loadOrderById(ctx.db, orderId);
    }),

  /**
   * Decline a refund request (SELLER / store owner only).
   *
   * Uses a guarded UPDATE to prevent approve↔decline races:
   *   UPDATE orders SET refundDeclinedAt = now(), refundRequestedAt = NULL WHERE id = ?
   *     AND storeId = ? AND refundRequestedAt IS NOT NULL AND refundApprovedAt IS NULL
   *     AND refundDeclinedAt IS NULL RETURNING { id }
   *
   * A 0-row result means the refund is not in a declinable state (no request,
   * already approved, or already declined) → BAD_REQUEST.
   * Does NOT call Stripe.
   */
  declineRefund: protectedProcedure
    .input(declineRefundInput)
    .output(orderSchema)
    .mutation(async ({ input, ctx }) => {
      const orderId = input.orderId;

      const [foundOrder] = await ctx.db
        .select(orderColumnsWithStore)
        .from(orders)
        .innerJoin(stores, eq(orders.storeId, stores.id))
        .where(eq(orders.id, orderId))
        .limit(1);

      // Surface as NOT_FOUND when not found or caller is not the store owner
      if (!foundOrder || foundOrder.storeUserId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }

      // Pre-check: give a precise error for non-refundable statuses.
      // The claim WHERE below is the real atomic guard.
      if (foundOrder.status !== "paid" && foundOrder.status !== "fulfilled") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only paid or fulfilled orders can be refunded",
        });
      }

      const now = new Date();
      // Guarded UPDATE — atomically claims the decline.
      // The status condition closes the race where the order moves to 'refunded'
      // or 'disputed' between the pre-check read and this UPDATE.
      const claimed = await ctx.db
        .update(orders)
        .set({
          refundDeclinedAt: now,
          refundRequestedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, foundOrder.storeId),
            or(eq(orders.status, "paid"), eq(orders.status, "fulfilled")),
            isNotNull(orders.refundRequestedAt),
            isNull(orders.refundApprovedAt),
            isNull(orders.refundDeclinedAt),
          ),
        )
        .returning({ id: orders.id });

      if (claimed.length === 0) {
        // Re-read to give a precise error message
        const [current] = await ctx.db
          .select({
            refundApprovedAt: orders.refundApprovedAt,
            refundDeclinedAt: orders.refundDeclinedAt,
            refundRequestedAt: orders.refundRequestedAt,
          })
          .from(orders)
          .where(eq(orders.id, orderId))
          .limit(1);

        if (current?.refundApprovedAt !== null && current?.refundApprovedAt !== undefined) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Refund already approved" });
        }
        if (current?.refundDeclinedAt !== null && current?.refundDeclinedAt !== undefined) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Refund already declined" });
        }
        throw new TRPCError({ code: "BAD_REQUEST", message: "No refund requested for this order" });
      }

      return loadOrderById(ctx.db, orderId);
    }),

  /**
   * Mark an order as fulfilled (SELLER / store owner only).
   *
   * Transition: paid → fulfilled.
   * This is a seller operational action, not a Stripe/webhook concern.
   * Webhooks own payment state (paid, refunded, disputed); fulfillment is seller-set.
   *
   * Uses an atomic guarded UPDATE to prevent races:
   *   UPDATE orders SET status = 'fulfilled', updatedAt = now()
   *     WHERE id = ? AND storeId = ? AND status = 'paid' RETURNING { id }
   *
   * A 0-row result means the order's status changed between the pre-check read
   * and the guarded UPDATE — surfaces as BAD_REQUEST with the same message as the
   * pre-check so the error is unambiguous without leaking concurrent state.
   * No Stripe call is made.
   */
  markFulfilled: protectedProcedure
    .input(markFulfilledInput)
    .output(orderSchema)
    .mutation(async ({ input, ctx }) => {
      const orderId = input.orderId;

      // Load order joined to stores for ownership check — same pattern as approveRefund/declineRefund
      const [foundOrder] = await ctx.db
        .select(orderColumnsWithStore)
        .from(orders)
        .innerJoin(stores, eq(orders.storeId, stores.id))
        .where(eq(orders.id, orderId))
        .limit(1);

      // Surface as NOT_FOUND when not found or caller is not the store owner
      // (avoid leaking order existence to non-owners)
      if (!foundOrder || foundOrder.storeUserId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }

      // Pre-check: give a precise error before the atomic claim
      if (foundOrder.status !== "paid") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only paid orders can be marked fulfilled",
        });
      }

      const now = new Date();
      // Atomic guarded UPDATE — prevents races where a concurrent webhook or seller
      // action transitions the order out of 'paid' between the pre-check and this UPDATE.
      const claimed = await ctx.db
        .update(orders)
        .set({ status: "fulfilled", updatedAt: now })
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, foundOrder.storeId),
            eq(orders.status, "paid"),
          ),
        )
        .returning({ id: orders.id });

      if (claimed.length === 0) {
        // Status raced away between the pre-check read and the guarded UPDATE.
        // A generic clear message is fine — the caller just needs to retry or reload.
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only paid orders can be marked fulfilled",
        });
      }

      return loadOrderById(ctx.db, orderId);
    }),

  /**
   * List all orders for the caller's store (SELLER only), newest first.
   * Returns an empty result set + null cursor if the caller has no store.
   *
   * Cursor pagination: keyset on (createdAt DESC, id DESC).
   * The opaque cursor encodes "<createdAtISO>|<id>" as base64.
   */
  listForMyStore: protectedProcedure
    .input(listForMyStoreInput)
    .output(listForMyStoreOutput)
    .query(async ({ input, ctx }) => {
      // Resolve the caller's store
      const [myStore] = await ctx.db
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.userId, ctx.user.id))
        .limit(1);

      if (!myStore) return { orders: [], nextCursor: null };

      const { limit, cursor } = input;

      // Decode and validate cursor using the module-level decodeCursor helper.
      // Uses atob/btoa (globally available in Node 16+ and React Native) rather than
      // Buffer so the server file type-checks under mobile's tsconfig (no node types).
      let cursorCreatedAt: Date | null = null;
      let cursorId: string | null = null;
      if (cursor) {
        const decoded = decodeCursor(cursor);
        cursorCreatedAt = decoded.createdAt;
        cursorId = decoded.id;
      }

      // Build the keyset predicate: (createdAt < cursorCreatedAt) OR (createdAt = cursorCreatedAt AND id < cursorId)
      const keysetCondition =
        cursorCreatedAt !== null && cursorId !== null
          ? or(
              lt(orders.createdAt, cursorCreatedAt),
              and(eq(orders.createdAt, cursorCreatedAt), lt(orders.id, cursorId)),
            )
          : undefined;

      const whereClause = keysetCondition
        ? and(eq(orders.storeId, myStore.id), keysetCondition)
        : eq(orders.storeId, myStore.id);

      // Fetch limit+1 to detect whether there's a next page
      const storeOrders = await ctx.db
        .select(orderColumns)
        .from(orders)
        .where(whereClause)
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(limit + 1);

      // Determine next cursor before trimming.
      let nextCursor: string | null = null;
      if (storeOrders.length > limit) {
        // storeOrders[limit - 1] = last row of this page (1-indexed: row `limit`); storeOrders[limit] is the probe row signalling there's more
        const lastRow = storeOrders[limit - 1]!;
        nextCursor = encodeCursor(lastRow.createdAt, lastRow.id);
      }

      // Trim to limit
      const pageOrders = storeOrders.slice(0, limit);

      if (pageOrders.length === 0) return { orders: [], nextCursor: null };

      const orderIds = pageOrders.map((o) => o.id);
      const allItems = await ctx.db
        .select(itemColumnsWithOrderId)
        .from(orderItems)
        .where(inArray(orderItems.orderId, orderIds));

      const itemsByOrder = new Map<string, typeof allItems>();
      for (const item of allItems) {
        const list = itemsByOrder.get(item.orderId) ?? [];
        list.push(item);
        itemsByOrder.set(item.orderId, list);
      }

      const mappedOrders = pageOrders.map((o) => mapOrder(o, itemsByOrder.get(o.id) ?? []));
      return { orders: mappedOrders, nextCursor };
    }),
});
