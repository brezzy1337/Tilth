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
 * Payment intents use destination charges:
 *   - `amount` = total buyer charge in cents
 *   - `application_fee_amount` = platform fee withheld from the seller's transfer
 *   - `transfer_data.destination` = the seller's connected account id
 *
 * The returned object additionally exposes `constructWebhookEvent` so that
 * `index.ts` can wire Stripe webhook signature verification using the same
 * underlying SDK instance — no dummy key required.
 */
export function createStripeClient(secretKey: string): StripeClient & {
  constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
    webhookSecret: string,
  ): Stripe.Event;
} {
  const stripe = new Stripe(secretKey);

  return {
    async createConnectedAccount(input) {
      const account = await stripe.accounts.create({
        type: "express",
        ...(input.email ? { email: input.email } : {}),
      });
      return { id: account.id };
    },

    async createAccountLink(input) {
      const link = await stripe.accountLinks.create({
        account: input.accountId,
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
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
      const pi = await stripe.paymentIntents.create({
        amount: input.amountCents,
        currency: "usd",
        application_fee_amount: input.applicationFeeCents,
        transfer_data: {
          destination: input.destinationAccountId,
        },
        metadata: input.metadata,
      });

      if (!pi.client_secret) {
        throw new Error("Stripe did not return a client_secret for the PaymentIntent");
      }

      return { id: pi.id, clientSecret: pi.client_secret };
    },

    constructWebhookEvent(rawBody, signature, webhookSecret) {
      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    },
  };
}
