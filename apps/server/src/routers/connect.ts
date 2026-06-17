/**
 * Connect router — Stripe Connect Express seller onboarding.
 *
 * `createOnboardingLink` — protected; creates or reuses a Connect account and
 *   returns a one-time Stripe-hosted onboarding URL.
 * `status` — protected; returns the seller's current Connect onboarding state
 *   as persisted by the `account.updated` webhook.
 *
 * Rules that must hold here:
 *   - No imports of env, db/index, or the Stripe SDK — everything via ctx.
 *   - The account id is persisted before the link is generated so a crash
 *     between the two steps doesn't leak an orphaned Stripe account.
 */

import { TRPCError } from "@trpc/server";
import {
  connectOnboardingInput,
  connectOnboardingResponse,
  connectStatus,
} from "@homegrown/shared";
import { eq } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc";
import { stores } from "../db/schema";
import { resolveCallerStoreWithConnect } from "./helpers";

export const connectRouter = router({
  /**
   * Create (or reuse) a Stripe Connect Express account for the caller's store
   * and return a one-time onboarding URL.
   *
   * If the store already has a `stripeConnectAccountId`, the existing account is reused
   * (idempotent — re-clicking "Start onboarding" is safe).
   */
  createOnboardingLink: protectedProcedure
    .input(connectOnboardingInput)
    .output(connectOnboardingResponse)
    .mutation(async ({ ctx }) => {
      const store = await resolveCallerStoreWithConnect(ctx.db, ctx.user.id);

      let accountId = store.stripeConnectAccountId;

      if (!accountId) {
        // Create a new Connect Express account.
        // Idempotency key = store.id: stable per store, prevents a duplicate account
        // if the create succeeds but DB persistence is retried.
        const created = await ctx.stripe.createConnectedAccount({
          idempotencyKey: store.id,
        });
        accountId = created.id;

        // Persist the id before generating the link — prevents orphaned accounts
        // if the link call fails.
        const [updated] = await ctx.db
          .update(stores)
          .set({ stripeConnectAccountId: accountId })
          .where(eq(stores.id, store.id))
          .returning({ id: stores.id });

        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to persist Stripe account id",
          });
        }
      }

      // Redirect URLs are server-side config — not accepted from the client (issue #7).
      let link: { url: string };
      try {
        link = await ctx.stripe.createAccountLink({ accountId });
      } catch (err) {
        console.error(
          "[connect.createOnboardingLink] account link failed",
          err instanceof Error ? err.message : String(err),
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to start onboarding. Please try again.",
        });
      }

      return { url: link.url, accountId };
    }),

  /**
   * Return the caller's Stripe Connect onboarding state.
   * State is kept fresh by the `account.updated` webhook in `webhook.ts`.
   */
  status: protectedProcedure.output(connectStatus).query(async ({ ctx }) => {
    const store = await resolveCallerStoreWithConnect(ctx.db, ctx.user.id);

    return {
      connected: !!store.stripeConnectAccountId,
      chargesEnabled: store.chargesEnabled,
      payoutsEnabled: store.payoutsEnabled,
      detailsSubmitted: store.detailsSubmitted,
    };
  }),
});
