/**
 * Stripe SDK wrapper — server-only.
 *
 * This file is the ONLY place in the router tree that imports the Stripe SDK.
 * Routers interact with Stripe through the `StripeClient` interface defined in
 * `context.ts`, so they stay SDK-free and mobile-typecheck-safe.
 *
 * `createStripeClient` is consumed by `index.ts` to construct the concrete client.
 * The returned object also exposes `constructWebhookEvent` for use in `index.ts`
 * when wiring the webhook route — this method lives on the concrete client only
 * and is NOT part of the `StripeClient` interface that routers depend on.
 */

import Stripe from "stripe";
import type { StripeClient } from "./context";

/**
 * Build a concrete `StripeClient` backed by the Stripe Node SDK.
 *
 * @param secretKey  - Stripe secret/restricted key (read from env, never hardcoded).
 * @param connect    - Server-side Connect redirect URLs. Baked in here so routers never
 *                     accept client-supplied URLs (prevents open-redirect, issue #7).
 *
 * API version is pinned to "2026-05-27.dahlia" — the latest version supported by
 * stripe@22.2.0. Pinning is required for deterministic webhook event/object shapes:
 * without an explicit apiVersion, Stripe would silently serve the account's default
 * version, which can drift as Stripe rolls out updates. Webhooks are our source of
 * truth for payment state; shape surprises there are unacceptable.
 *
 * `maxNetworkRetries: 2` enables Stripe SDK-level retry with exponential back-off on
 * transient network failures, which are idempotent for read operations and for writes
 * that carry a client-supplied idempotency key.
 *
 * Payment intents use destination charges:
 *   - `amount` = total buyer charge in cents
 *   - `application_fee_amount` = platform fee withheld from the seller's transfer
 *   - `transfer_data.destination` = the seller's connected account id
 *
 * The returned object additionally exposes `constructWebhookEvent` so that
 * `index.ts` can wire Stripe webhook signature verification using the same
 * underlying SDK instance — no dummy key required.
 */
export function createStripeClient(
  secretKey: string,
  connect: { refreshUrl: string; returnUrl: string },
): StripeClient & {
  constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
    webhookSecret: string,
  ): Stripe.Event;
} {
  const stripe = new Stripe(secretKey, {
    // Pinned to the latest API version accepted by stripe@22.2.0 types.
    // Pinning ensures deterministic webhook event/object shapes — essential because
    // webhooks are the source of truth for all payment state in HomeGrown.
    apiVersion: "2026-05-27.dahlia",
    // SDK-level retry with exponential back-off for transient network errors.
    // Safe alongside idempotency keys: Stripe deduplicates server-side.
    maxNetworkRetries: 2,
  });

  return {
    async createConnectedAccount(input) {
      const account = await stripe.accounts.create(
        {
          type: "express",
          ...(input.email ? { email: input.email } : {}),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: account.id };
    },

    async createAccountLink(input) {
      const link = await stripe.accountLinks.create({
        account: input.accountId,
        // Use the server-side URLs baked in at construction — never accept these from the client.
        refresh_url: connect.refreshUrl,
        return_url: connect.returnUrl,
        type: "account_onboarding",
      });
      return { url: link.url };
    },

    async retrieveAccountStatus(accountId) {
      const account = await stripe.accounts.retrieve(accountId);
      return {
        chargesEnabled: account.charges_enabled ?? false,
        payoutsEnabled: account.payouts_enabled ?? false,
        detailsSubmitted: account.details_submitted ?? false,
      };
    },

    async createPaymentIntent(input) {
      const pi = await stripe.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: "usd",
          application_fee_amount: input.applicationFeeCents,
          transfer_data: {
            destination: input.destinationAccountId,
          },
          metadata: input.metadata,
          // Manual capture: funds are only AUTHORIZED here. Capture (and the
          // resulting destination transfer + application fee) is deferred until
          // the seller marks the order fulfilled (see routers/orders.ts markFulfilled).
          capture_method: "manual",
        },
        { idempotencyKey: input.idempotencyKey },
      );

      if (!pi.client_secret) {
        throw new Error("Stripe did not return a client_secret for the PaymentIntent");
      }

      return { id: pi.id, clientSecret: pi.client_secret };
    },

    async retrievePaymentIntent(id) {
      const pi = await stripe.paymentIntents.retrieve(id);
      return { status: pi.status };
    },

    async cancelPaymentIntent(id) {
      const pi = await stripe.paymentIntents.cancel(id);
      return { status: pi.status };
    },

    async capturePaymentIntent(id) {
      const pi = await stripe.paymentIntents.capture(id);
      return { status: pi.status };
    },

    async refundPayment(input) {
      // reverse_transfer: true — claws back the destination transfer to the seller.
      // refund_application_fee: true — returns the platform fee to the buyer.
      // Together these are the correct platform-protection refund shape for
      // destination charges where the platform is the merchant of record.
      // TODO(PR3): wire caller + amount_owed accounting on reverse-transfer shortfall.
      const refund = await stripe.refunds.create(
        {
          payment_intent: input.paymentIntentId,
          ...(input.amountCents !== undefined ? { amount: input.amountCents } : {}),
          reverse_transfer: true,
          refund_application_fee: true,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: refund.id, status: refund.status ?? "unknown", amountRefunded: refund.amount };
    },

    async createDashboardLink(accountId) {
      const link = await stripe.accounts.createLoginLink(accountId);
      return { url: link.url };
    },

    constructWebhookEvent(rawBody, signature, webhookSecret) {
      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    },
  };
}
