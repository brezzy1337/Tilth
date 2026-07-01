/**
 * tRPC request context.
 *
 * `createContext` accepts injected deps (`db`, `jwtSecret`, `auth`, and `geocode`)
 * so that the router import tree never touches `./env`, `./db/index`, or `./auth` —
 * those modules have side-effects (env validation, DB connection, node:crypto)
 * that break mobile's typecheck and the env-free test invariant.
 *
 * The `db` type is expressed via Drizzle's `PostgresJsDatabase` + the schema
 * type, rather than `typeof db` from `./db/index`, to avoid following that
 * module's import chain into env.ts.
 *
 * Auth flow:
 *   1. Read the `Authorization: Bearer <token>` header.
 *   2. Verify via `deps.auth.verifyToken` (returns user id on success, null otherwise).
 *   3. Populate `ctx.user` with `{ id }` on success, else null.
 */

import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "./db/schema";

/**
 * Interface for password and token helpers.
 * Defined here (not in auth.ts) so routers can depend on the interface without
 * pulling in node:crypto types — which mobile's tsc cannot resolve.
 */
export interface AuthHelpers {
  hashPassword(plain: string): Promise<string>;
  verifyPassword(plain: string, stored: string): Promise<boolean>;
  signToken(userId: string, secret: string): Promise<string>;
  verifyToken(token: string, secret: string): Promise<string | null>;
}

/**
 * Interface for geocoding an address to lat/lng.
 * Defined here (not in geocode.ts) so routers can depend on the interface without
 * pulling in the geocode module — which would break mobile's typecheck.
 */
export interface Geocoder {
  (input: {
    address: string;
    city: string;
    state: string;
    zip: string;
  }): Promise<{ lat: number; lng: number } | null>;
}

/**
 * DI interface for Stripe operations.
 *
 * Plain object return shapes only — no `Stripe.*` SDK types leak here so the
 * router import tree stays SDK-free and mobile's typecheck is unaffected.
 * The concrete implementation lives in `stripe.ts` and is wired in `index.ts`.
 */
export interface StripeClient {
  /**
   * Create a Stripe Connect Express account. Returns the new account id.
   * `idempotencyKey` — stable per-store key that prevents duplicate accounts
   * if the create succeeds but DB persistence is retried.
   */
  createConnectedAccount(input: {
    email?: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
  /**
   * Generate a one-time Connect onboarding URL.
   * The redirect URLs are baked into the concrete client from env vars — callers
   * must NOT supply them (prevents open-redirect: issue #7).
   */
  createAccountLink(input: { accountId: string }): Promise<{ url: string }>;
  /** Read the current onboarding state of a connected account. */
  retrieveAccountStatus(accountId: string): Promise<{
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  }>;
  /**
   * Create a destination-charge PaymentIntent.
   * `amountCents` is the total charged to the buyer (integer cents, USD).
   * `applicationFeeCents` is withheld from the seller's transfer.
   * `idempotencyKey` — pass a stable per-order key so client retries of the same
   * order never create duplicate PaymentIntents on Stripe's side.
   */
  createPaymentIntent(input: {
    amountCents: number;
    applicationFeeCents: number;
    destinationAccountId: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; clientSecret: string }>;
  /**
   * Read the current status of a PaymentIntent.
   * Plain return shape — no Stripe SDK types leak into this interface.
   * Used by the reconciliation poller to detect succeeded PIs that were missed
   * by the webhook (e.g. when the connected-account webhook was not yet wired).
   */
  retrievePaymentIntent(id: string): Promise<{ status: string }>;
  /**
   * Cancel a PaymentIntent.
   * Used by the abandoned-PI sweeper in the reconciliation poller.
   * Returns the new status (should be "canceled" after a successful cancel call).
   */
  cancelPaymentIntent(id: string): Promise<{ status: string }>;
  /**
   * Capture a previously-authorized (manual-capture) PaymentIntent.
   *
   * Under HomeGrown's manual-capture destination-charge flow, `createPaymentIntent`
   * only AUTHORIZES funds; capture is deferred until the seller marks the order
   * fulfilled (`orders.markFulfilled`). Capturing is what actually moves money —
   * it triggers the destination transfer + application fee.
   *
   * Returns the new status (should be "succeeded" after a successful capture call).
   */
  capturePaymentIntent(id: string): Promise<{ status: string }>;
  /**
   * Generate a one-time Express Dashboard login link for a connected account.
   * Only works for Express accounts that have completed onboarding
   * (`details_submitted = true`). Callers must verify this before calling.
   */
  createDashboardLink(accountId: string): Promise<{ url: string }>;
  /**
   * Issue a refund for a destination-charge PaymentIntent.
   *
   * Uses `reverse_transfer: true` and `refund_application_fee: true` to claw
   * back the seller's transfer and return the platform fee — the correct shape
   * for platform-as-merchant-of-record destination charges.
   *
   * `amountCents` is optional; omit for a full refund.
   * `idempotencyKey` prevents duplicate refunds on client retries.
   *
   * TODO(PR3): wire caller + amount_owed accounting on reverse-transfer shortfall.
   */
  refundPayment(input: {
    paymentIntentId: string;
    amountCents?: number;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string; amountRefunded: number }>;
}

/** The database type — Drizzle + our schema. */
export type Db = PostgresJsDatabase<typeof schema>;

/** Shape of the injected runtime dependencies. */
export interface ContextDeps {
  db: Db;
  jwtSecret: string;
  auth: AuthHelpers;
  geocode: Geocoder;
  stripe: StripeClient;
}

export async function createContext({ req }: CreateHTTPContextOptions, deps: ContextDeps) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let user: { id: string } | null = null;
  if (token) {
    const userId = await deps.auth.verifyToken(token, deps.jwtSecret);
    if (userId) {
      user = { id: userId };
    }
  }

  return {
    db: deps.db,
    jwtSecret: deps.jwtSecret,
    auth: deps.auth,
    geocode: deps.geocode,
    stripe: deps.stripe,
    user,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
