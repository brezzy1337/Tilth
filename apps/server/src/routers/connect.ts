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
  connectDashboardLinkResponse,
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
        //
        // Idempotency key: time-bucketed per store (~60-second window).
        //
        // WHY NOT store.id alone: Stripe caches accounts.create responses against
        // the idempotency key for 24h — including error responses. A static store.id
        // key means any transient or terminal error (e.g. "You can only create new
        // accounts if you've signed up for Connect", observed 2026-06-27) poisons the
        // key for 24h, wedging the store even after the root cause is fixed.
        //
        // WHY time-bucketing works: a ~60-second bucket caps the poison window to one
        // minute while still deduplicating rapid concurrent retries within the same
        // bucket (the create→persist race: create succeeds, DB persist fails and
        // retries within the same minute → same key → Stripe returns the cached
        // success, no duplicate account is created).
        //
        // DO NOT simplify this back to `store.id` — the time component is load-bearing.
        const created = await ctx.stripe.createConnectedAccount({
          idempotencyKey: `${store.id}:${Math.floor(Date.now() / 60_000)}`,
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

  /**
   * Generate a one-time Stripe Express Dashboard login link.
   *
   * The Stripe Express Dashboard shows the seller their balance and payout
   * history without requiring HomeGrown to build that UI.
   *
   * Requires that the seller has completed onboarding (`detailsSubmitted=true`).
   * `accounts.createLoginLink` will reject for non-onboarded accounts — we
   * guard explicitly so we surface a clean PRECONDITION_FAILED instead of an
   * opaque Stripe error.
   *
   * This is a mutation because it creates a one-time link (not cacheable).
   */
  dashboardLink: protectedProcedure
    .output(connectDashboardLinkResponse)
    .mutation(async ({ ctx }) => {
      const store = await resolveCallerStoreWithConnect(ctx.db, ctx.user.id);

      if (!store.stripeConnectAccountId || !store.detailsSubmitted) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Complete Stripe onboarding before viewing earnings.",
        });
      }

      let link: { url: string };
      try {
        link = await ctx.stripe.createDashboardLink(store.stripeConnectAccountId);
      } catch (err) {
        console.error(
          "[connect.dashboardLink] login link creation failed",
          err instanceof Error ? err.message : String(err),
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to generate dashboard link. Please try again.",
        });
      }

      return { url: link.url };
    }),
});
