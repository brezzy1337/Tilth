/**
 * Orders router — M4 Payments backbone.
 *
 * `create`    — protected; builds an order from listing ids, creates a Stripe
 *               destination-charge PaymentIntent, returns the clientSecret.
 * `listMine`  — protected; returns the authenticated buyer's orders, newest first.
 * `get`       — protected; returns a single order (caller must be buyer or store owner).
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
  order as orderSchema,
  type Order,
  type OrderItemOutput,
} from "@homegrown/shared";
import { eq, inArray, desc } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc";
import { orders, orderItems, listings, stores } from "../db/schema";

/**
 * Platform fee in basis points (1 bp = 0.01%).
 * 1000 bps = 10% — HomeGrown's pilot rate.
 * Withheld from the seller's transfer via `application_fee_amount` on the destination charge.
 */
const PLATFORM_FEE_BPS = 1000;

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
    items: itemRows.map(mapOrderItem),
    createdAt: orderRow.createdAt.toISOString(),
    updatedAt: orderRow.updatedAt.toISOString(),
  };
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
        // orderId is created inside the DB transaction above — stable across client retries
        // of the same order, so this key prevents duplicate PaymentIntents on Stripe's side.
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
        .select({
          id: orders.id,
          storeId: orders.storeId,
          buyerId: orders.buyerId,
          status: orders.status,
          subtotalCents: orders.subtotalCents,
          applicationFeeCents: orders.applicationFeeCents,
          totalCents: orders.totalCents,
          stripePaymentIntentId: orders.stripePaymentIntentId,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
        })
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
        .select({
          id: orders.id,
          storeId: orders.storeId,
          buyerId: orders.buyerId,
          status: orders.status,
          subtotalCents: orders.subtotalCents,
          applicationFeeCents: orders.applicationFeeCents,
          totalCents: orders.totalCents,
          stripePaymentIntentId: orders.stripePaymentIntentId,
          createdAt: orders.createdAt,
          updatedAt: orders.updatedAt,
          storeUserId: stores.userId,
        })
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
});
