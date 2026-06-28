/**
 * Unit tests for connect.createOnboardingLink — idempotency key time-bucketing.
 *
 * These tests assert that the idempotency key passed to Stripe's accounts.create is
 * time-bucketed (~60-second window) per store, so that:
 *
 *   (a) Concurrent / near-immediate retries within the same bucket share a key and
 *       dedup on Stripe's side, protecting the create→persist race.
 *   (b) A store poisoned by a cached failure (Stripe caches error responses for 24h
 *       against the idempotency key, observed 2026-06-27) recovers within ~60 seconds
 *       because a new bucket produces a new key that bypasses the cached error.
 *
 * `Date.now` is controlled via vi.spyOn so the bucket boundary can be crossed in tests
 * without real wall-clock delays.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context } from "../context";
import * as authHelpers from "../auth";

const createCaller = createCallerFactory(appRouter);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_STORE = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const UUID_USER  = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33";
const STRIPE_ACCOUNT_ID = "acct_test_bucket";
const TEST_SECRET = "test-jwt-secret-that-is-at-least-32-chars";

const stubAuth: Context["auth"] = {
  hashPassword:   authHelpers.hashPassword,
  verifyPassword: authHelpers.verifyPassword,
  signToken:      authHelpers.signToken,
  verifyToken:    authHelpers.verifyToken,
};

// ---------------------------------------------------------------------------
// Restore mocks after every test
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Context factory
//
// The store always returns stripeConnectAccountId=null so the create path is
// entered on every call. capturedKeys receives the idempotencyKey from each
// createConnectedAccount invocation.
// ---------------------------------------------------------------------------

function makeCtx(capturedKeys: string[]): Context {
  const storeRow = {
    id: UUID_STORE,
    stripeConnectAccountId: null,
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
  };

  const b = {
    from:  () => b,
    where: () => b,
    limit: () => Promise.resolve([storeRow]),
    then:  (resolve: (v: unknown[]) => void) => Promise.resolve([storeRow]).then(resolve),
  };
  const updateBuilder = {
    set:       () => updateBuilder,
    where:     () => updateBuilder,
    returning: () => Promise.resolve([{ id: UUID_STORE }]),
  };
  const db = {
    select: () => b,
    update: () => updateBuilder,
  } as unknown as Context["db"];

  const stripe: Context["stripe"] = {
    createConnectedAccount: vi.fn(async (input: { idempotencyKey: string }) => {
      capturedKeys.push(input.idempotencyKey);
      return { id: STRIPE_ACCOUNT_ID };
    }),
    createAccountLink:     async () => ({ url: "https://connect.stripe.com/setup/test" }),
    retrieveAccountStatus: async () => ({
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    }),
    createPaymentIntent:   async () => { throw new Error("stub: not implemented"); },
    retrievePaymentIntent: async () => { throw new Error("stub: not implemented"); },
    cancelPaymentIntent:   async () => { throw new Error("stub: not implemented"); },
    refundPayment:         async () => { throw new Error("stub: not implemented"); },
    createDashboardLink:   async () => { throw new Error("stub: not implemented"); },
  };

  return {
    db,
    jwtSecret: TEST_SECRET,
    auth:      stubAuth,
    geocode:   async () => null,
    stripe,
    user:      { id: UUID_USER },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("connect.createOnboardingLink — time-bucketed idempotency key", () => {
  /**
   * Two calls that land in the same ~60-second bucket must produce the SAME
   * idempotencyKey so Stripe deduplicates them server-side.
   *
   * This protects the create→persist race: create succeeds, the DB persist fails
   * and retries within the same minute → Stripe returns the cached account id
   * instead of creating a second account.
   */
  it("passes the SAME idempotencyKey for two calls within the same 60-second bucket", async () => {
    // Pin Date.now to a fixed millisecond inside a single bucket (28394400 minutes).
    vi.spyOn(Date, "now").mockReturnValue(28394400 * 60_000 + 5_000);

    const keys: string[] = [];

    await createCaller(makeCtx(keys)).connect.createOnboardingLink({});
    await createCaller(makeCtx(keys)).connect.createOnboardingLink({});

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    // Key must be scoped to the store (prefix) followed by the numeric bucket.
    expect(keys[0]).toMatch(new RegExp(`^${UUID_STORE}:\\d+$`));
  });

  /**
   * Two calls that land in DIFFERENT ~60-second buckets must produce DIFFERENT
   * idempotencyKeys so the second call is NOT served the cached (error) response
   * from the first call.
   *
   * This limits the poison window for cached errors to ~60 seconds instead of 24h.
   */
  it("passes DIFFERENT idempotencyKeys for calls in different 60-second buckets", async () => {
    const dateSpy = vi.spyOn(Date, "now");
    const keys: string[] = [];

    // First call in bucket N.
    dateSpy.mockReturnValue(28394400 * 60_000);
    await createCaller(makeCtx(keys)).connect.createOnboardingLink({});

    // Second call in bucket N+1 — a store wedged by a cached failure from bucket N
    // will bypass that cache and get a fresh attempt from Stripe.
    dateSpy.mockReturnValue(28394401 * 60_000);
    await createCaller(makeCtx(keys)).connect.createOnboardingLink({});

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    // Both keys must be scoped to the same store with different numeric buckets.
    expect(keys[0]).toMatch(new RegExp(`^${UUID_STORE}:\\d+$`));
    expect(keys[1]).toMatch(new RegExp(`^${UUID_STORE}:\\d+$`));
  });
});
