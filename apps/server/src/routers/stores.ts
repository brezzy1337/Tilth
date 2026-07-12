/**
 * Stores router — create and fetch store profiles.
 *
 * One store per user (enforced by unique FK at the DB level and checked here).
 * Stripe Connect onboarding is OUT OF SCOPE for M2 — the column is carried
 * but no Stripe logic is wired.
 *
 * All procedures read `ctx.db`. No direct imports of env or db.
 */

import { TRPCError } from "@trpc/server";
import {
  createStoreInput,
  getStoreInput,
  store as storeSchema,
  storeProfile,
  computeTrustTier,
} from "@homegrown/shared";
import { eq, sql } from "drizzle-orm";
import { publicProcedure, protectedProcedure, router } from "../trpc";
import { stores, orders, users } from "../db/schema";

export const storesRouter = router({
  /**
   * Create a store for the authenticated user.
   * Enforces one-store-per-user (CONFLICT if one already exists).
   */
  create: protectedProcedure
    .input(createStoreInput)
    .output(storeSchema)
    .mutation(async ({ input, ctx }) => {
      // Enforce one-store-per-user
      const existing = await ctx.db
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.userId, ctx.user.id))
        .limit(1);

      if (existing.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "You already have a store",
        });
      }

      let newStore:
        | {
            id: string;
            userId: string;
            name: string;
            logo: string | null;
            about: string | null;
            stripeConnectAccountId: string | null;
          }
        | undefined;
      try {
        const [inserted] = await ctx.db
          .insert(stores)
          .values({
            userId: ctx.user.id,
            name: input.name,
            logo: input.logo ?? null,
            about: input.about ?? null,
          })
          .returning({
            id: stores.id,
            userId: stores.userId,
            name: stores.name,
            logo: stores.logo,
            about: stores.about,
            stripeConnectAccountId: stores.stripeConnectAccountId,
          });
        newStore = inserted;
      } catch (err) {
        // Postgres unique-violation (SQLSTATE 23505) means a concurrent duplicate
        // slipped past the precheck SELECT — surface it as a clean CONFLICT.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: unknown }).code === "23505"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "You already have a store.",
          });
        }
        throw err;
      }

      if (!newStore) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create store",
        });
      }

      return {
        id: newStore.id,
        userId: newStore.userId,
        name: newStore.name,
        logo: newStore.logo ?? null,
        about: newStore.about ?? null,
        stripeConnectAccountId: newStore.stripeConnectAccountId ?? null,
      };
    }),

  /**
   * Return the authenticated user's store, or null if they don't have one yet.
   */
  getMine: protectedProcedure
    .output(storeSchema.nullable())
    .query(async ({ ctx }) => {
      const [found] = await ctx.db
        .select({
          id: stores.id,
          userId: stores.userId,
          name: stores.name,
          logo: stores.logo,
          about: stores.about,
          stripeConnectAccountId: stores.stripeConnectAccountId,
        })
        .from(stores)
        .where(eq(stores.userId, ctx.user.id))
        .limit(1);

      if (!found) return null;

      return {
        id: found.id,
        userId: found.userId,
        name: found.name,
        logo: found.logo ?? null,
        about: found.about ?? null,
        stripeConnectAccountId: found.stripeConnectAccountId ?? null,
      };
    }),

  /**
   * Public store profile. Returns NOT_FOUND if the store doesn't exist.
   * Only exposes the buyer-safe subset: id, name, logo, about, trustTier.
   * userId and stripeConnectAccountId are intentionally omitted.
   *
   * F-016 — trustTier is computed from TERMINAL order counts only
   * (fulfilled/cancelled/refunded); pending_payment/paid/disputed are excluded
   * via the FILTER clauses below. computeTrustTier (shared) owns the thresholds.
   */
  get: publicProcedure
    .input(getStoreInput)
    .output(storeProfile)
    .query(async ({ input, ctx }) => {
      const [found] = await ctx.db
        .select({
          id: stores.id,
          name: stores.name,
          logo: stores.logo,
          about: stores.about,
          // F-051 — not selected into the response; used only to hide a
          // deactivated seller's public profile behind the same NOT_FOUND
          // as a nonexistent store.
          ownerDeactivatedAt: users.deactivatedAt,
        })
        .from(stores)
        .innerJoin(users, eq(users.id, stores.userId))
        .where(eq(stores.id, input.storeId))
        .limit(1);

      if (!found || found.ownerDeactivatedAt) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Store not found",
        });
      }

      // Single conditional-aggregation query over orders_store_id_idx.
      // No GROUP BY, so this always returns exactly one row (all zeros when the
      // store has no terminal orders yet) — never undefined.
      const [counts] = await ctx.db
        .select({
          fulfilled: sql<number>`count(*) filter (where ${orders.status} = 'fulfilled')`.mapWith(
            Number,
          ),
          cancelled: sql<number>`count(*) filter (where ${orders.status} = 'cancelled')`.mapWith(
            Number,
          ),
          refunded: sql<number>`count(*) filter (where ${orders.status} = 'refunded')`.mapWith(
            Number,
          ),
        })
        .from(orders)
        .where(eq(orders.storeId, input.storeId));

      const trustTier = computeTrustTier({
        fulfilled: counts?.fulfilled ?? 0,
        cancelled: counts?.cancelled ?? 0,
        refunded: counts?.refunded ?? 0,
      });

      return {
        id: found.id,
        name: found.name,
        logo: found.logo ?? null,
        about: found.about ?? null,
        trustTier,
      };
    }),
});

