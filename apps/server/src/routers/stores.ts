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
} from "@homegrown/shared";
import { eq } from "drizzle-orm";
import { publicProcedure, protectedProcedure, router } from "../trpc";
import { stores } from "../db/schema";

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

      const [newStore] = await ctx.db
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
   */
  get: publicProcedure
    .input(getStoreInput)
    .output(storeSchema)
    .query(async ({ input, ctx }) => {
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
        .where(eq(stores.id, input.storeId))
        .limit(1);

      if (!found) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Store not found",
        });
      }

      return {
        id: found.id,
        userId: found.userId,
        name: found.name,
        logo: found.logo ?? null,
        about: found.about ?? null,
        stripeConnectAccountId: found.stripeConnectAccountId ?? null,
      };
    }),
});

