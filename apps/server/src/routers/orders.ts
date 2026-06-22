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
 * `listForMyStore`— protected; returns all orders for the caller's store, newest first.
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
  order as orderSchema,
  type Order,
  type OrderItemOutput,
} from "@homegrown/shared";
import { eq, inArray, desc, and } from "drizzle-orm";
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
  refundRequestedAt: orders.refundRequestedAt,
  refundReason: orders.refundReason,
  refundApprovedAt: orders.refundApprovedAt,
  refundDeclinedAt: orders.refundDeclinedAt,
  createdAt: orders.createdAt,
  updatedAt: orders.updatedAt,
} as const;

/**
 * Extends orderColumns with `storeUserId` for procedures that join stores.
 * Used in `get`, `approveRefund`, `declineRefund`.
 */
const orderColumnsWithStore = {
  ...orderColumns,
  storeUserId: stores.userId,
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
    .select({
      id: orderItems.id,
      listingId: orderItems.listingId,
      nameSnapshot: orderItems.nameSnapshot,
      unitPriceCents: orderItems.unitPriceCents,
      quantity: orderItems.quantity,
      lineTotalCents: orderItems.lineTotalCents,
    })
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
        .select({
          id: orderItems.id,
          orderId: orderItems.orderId,
          listingId: orderItems.listingId,
          nameSnapshot: orderItems.nameSnapshot,
          unitPriceCents: orderItems.unitPriceCents,
          quantity: orderItems.quantity,
          lineTotalCents: orderItems.lineTotalCents,
        })
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
        .select({
          id: orderItems.id,
          listingId: orderItems.listingId,
          nameSnapshot: orderItems.nameSnapshot,
          unitPriceCents: orderItems.unitPriceCents,
          quantity: orderItems.quantity,
          lineTotalCents: orderItems.lineTotalCents,
        })
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
      await ctx.db
        .update(orders)
        .set({
          refundRequestedAt: now,
          refundReason: input.reason ?? null,
          refundDeclinedAt: null,
          updatedAt: now,
        })
        .where(and(eq(orders.id, input.orderId), eq(orders.buyerId, ctx.user.id)));

      return loadOrderById(ctx.db, input.orderId);
    }),

  /**
   * Approve a refund request (SELLER / store owner only).
   *
   * Asserts:
   *   - Caller owns the store (else NOT_FOUND to avoid leaking order existence).
   *   - A refund was requested (else BAD_REQUEST).
   *   - Status is 'paid' or 'fulfilled' and stripePaymentIntentId is present.
   *
   * Calls Stripe refundPayment with a stable per-order idempotency key (full refund).
   * Sets refund_approved_at = now(). Does NOT set status='refunded' — the
   * charge.refunded webhook is the source of truth for that transition.
   */
  approveRefund: protectedProcedure
    .input(approveRefundInput)
    .output(orderSchema)
    .mutation(async ({ input, ctx }) => {
      const [foundOrder] = await ctx.db
        .select(orderColumnsWithStore)
        .from(orders)
        .innerJoin(stores, eq(orders.storeId, stores.id))
        .where(eq(orders.id, input.orderId))
        .limit(1);

      // Surface as NOT_FOUND when not found or caller is not the store owner
      if (!foundOrder || foundOrder.storeUserId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }

      if (foundOrder.refundRequestedAt === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No refund requested for this order",
        });
      }

      if (foundOrder.refundApprovedAt !== null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Refund already approved" });
      }

      if (foundOrder.status !== "paid" && foundOrder.status !== "fulfilled") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only paid or fulfilled orders can be refunded",
        });
      }

      if (!foundOrder.stripePaymentIntentId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Order has no payment intent; cannot refund",
        });
      }

      // Full refund — omit amountCents. Stable per-order key makes a double-approve a Stripe no-op.
      await ctx.stripe.refundPayment({
        paymentIntentId: foundOrder.stripePaymentIntentId,
        idempotencyKey: `refund-${foundOrder.id}`,
      });

      const now = new Date();
      await ctx.db
        .update(orders)
        .set({
          refundApprovedAt: now,
          updatedAt: now,
        })
        .where(and(eq(orders.id, input.orderId), eq(orders.storeId, foundOrder.storeId)));

      return loadOrderById(ctx.db, input.orderId);
    }),

  /**
   * Decline a refund request (SELLER / store owner only).
   *
   * Asserts:
   *   - Caller owns the store (else NOT_FOUND to avoid leaking order existence).
   *   - A refund was requested (else BAD_REQUEST).
   *   - Refund not yet approved (else BAD_REQUEST).
   *   - Refund not already declined (else BAD_REQUEST).
   *
   * Sets refund_declined_at = now() and clears refund_requested_at so the
   * buyer can re-request. Does NOT call Stripe.
   */
  declineRefund: protectedProcedure
    .input(declineRefundInput)
    .output(orderSchema)
    .mutation(async ({ input, ctx }) => {
      const [foundOrder] = await ctx.db
        .select(orderColumnsWithStore)
        .from(orders)
        .innerJoin(stores, eq(orders.storeId, stores.id))
        .where(eq(orders.id, input.orderId))
        .limit(1);

      // Surface as NOT_FOUND when not found or caller is not the store owner
      if (!foundOrder || foundOrder.storeUserId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }

      if (foundOrder.refundRequestedAt === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No refund requested for this order",
        });
      }

      if (foundOrder.refundApprovedAt !== null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Refund already approved" });
      }

      if (foundOrder.refundDeclinedAt !== null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Refund already declined" });
      }

      const now = new Date();
      await ctx.db
        .update(orders)
        .set({
          refundDeclinedAt: now,
          refundRequestedAt: null,
          updatedAt: now,
        })
        .where(and(eq(orders.id, input.orderId), eq(orders.storeId, foundOrder.storeId)));

      return loadOrderById(ctx.db, input.orderId);
    }),

  /**
   * List all orders for the caller's store (SELLER only), newest first.
   * Returns an empty array if the caller has no store.
   */
  listForMyStore: protectedProcedure
    .output(orderSchema.array())
    .query(async ({ ctx }) => {
      // Resolve the caller's store
      const [myStore] = await ctx.db
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.userId, ctx.user.id))
        .limit(1);

      if (!myStore) return [];

      const storeOrders = await ctx.db
        .select(orderColumns)
        .from(orders)
        .where(eq(orders.storeId, myStore.id))
        .orderBy(desc(orders.createdAt));

      if (storeOrders.length === 0) return [];

      const orderIds = storeOrders.map((o) => o.id);
      const allItems = await ctx.db
        .select({
          id: orderItems.id,
          orderId: orderItems.orderId,
          listingId: orderItems.listingId,
          nameSnapshot: orderItems.nameSnapshot,
          unitPriceCents: orderItems.unitPriceCents,
          quantity: orderItems.quantity,
          lineTotalCents: orderItems.lineTotalCents,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, orderIds));

      const itemsByOrder = new Map<string, typeof allItems>();
      for (const item of allItems) {
        const list = itemsByOrder.get(item.orderId) ?? [];
        list.push(item);
        itemsByOrder.set(item.orderId, list);
      }

      return storeOrders.map((o) => mapOrder(o, itemsByOrder.get(o.id) ?? []));
    }),
});
