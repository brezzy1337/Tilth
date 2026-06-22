/**
 * Unit tests for the reconcile() function.
 *
 * Fast — no real DB, no network, no Stripe SDK.
 * Uses the same dependency-injection + fake-DB style as webhook.test.ts and
 * orders.test.ts: small objects that record calls and return canned data.
 *
 * Coverage:
 *   - A store with chargesEnabled=false whose retrieveAccountStatus returns
 *     true → gets updated; storesUpdated increments.
 *   - A store already fully enabled is NOT selected (filtered by query) →
 *     storesUpdated unaffected.
 *   - A stale pending_payment order whose PI returns status:'succeeded' →
 *     flips to paid (ordersMarkedPaid = 1).
 *   - A PI still requires_payment_method → order stays pending_payment.
 *   - A retrieveAccountStatus that throws for one store does NOT abort the
 *     run; errors increments and other stores still process.
 */

import { describe, it, expect, vi } from "vitest";
import { reconcile } from "./reconcile";
import type { Db, StripeClient } from "../context";

// ---------------------------------------------------------------------------
// Fake DB builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake Db that:
 *   - select() returns rows from `selectSequence` in call order (or `selectRows` for all calls).
 *   - update().set().where() records calls and resolves void.
 */
function fakeDb(opts: {
  /** Each call to db.select() returns the next array in this sequence. */
  selectSequence?: unknown[][];
  /** Fallback rows for all select calls when selectSequence is not provided. */
  selectRows?: unknown[];
  /** Called with the `set` argument of every update().set() call. */
  onUpdate?: (set: unknown) => void;
}) {
  let selectCallCount = 0;

  const selectFn = () => {
    const rows = opts.selectSequence
      ? (opts.selectSequence[selectCallCount++] ?? [])
      : (opts.selectRows ?? []);

    // The builder must support the chaining pattern:
    //   db.select({ ... }).from(table).where(condition)
    // The result is awaited directly, so we implement `then` to make it a thenable.
    const builder: {
      from: (...args: unknown[]) => typeof builder;
      where: (...args: unknown[]) => typeof builder;
      then: (
        resolve: (v: unknown[]) => void,
        reject: (e: unknown) => void,
      ) => void;
    } = {
      from: () => builder,
      where: () => builder,
      then: (resolve) => {
        Promise.resolve(rows).then(resolve);
      },
    };
    return builder;
  };

  const updateBuilder: {
    set: (s: unknown) => typeof updateBuilder;
    where: (...args: unknown[]) => Promise<void>;
  } = {
    set: (s: unknown) => {
      opts.onUpdate?.(s);
      return updateBuilder;
    },
    where: () => Promise.resolve(),
  };

  const updateFn = () => updateBuilder;

  return {
    select: selectFn,
    update: updateFn,
  } as unknown as Db;
}

// ---------------------------------------------------------------------------
// Fake Stripe builder
// ---------------------------------------------------------------------------

type StripeStub = Pick<StripeClient, "retrieveAccountStatus" | "retrievePaymentIntent">;

function makeStripeStub(overrides: Partial<StripeStub> = {}): StripeStub {
  return {
    retrieveAccountStatus: async () => ({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    }),
    retrievePaymentIntent: async () => ({ status: "succeeded" }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_STORE_1 = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const UUID_STORE_2 = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const UUID_ORDER_1 = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33";
const STRIPE_ACCT_ID = "acct_test1234";
const STRIPE_PI_ID = "pi_test_abc123";

// ---------------------------------------------------------------------------
// Pass 1: Onboarding resync tests
// ---------------------------------------------------------------------------

describe("reconcile — onboarding resync (stores)", () => {
  it("updates a store whose chargesEnabled is false but Stripe says true", async () => {
    const storeRow = {
      id: UUID_STORE_1,
      stripeConnectAccountId: STRIPE_ACCT_ID,
      chargesEnabled: false,
      payoutsEnabled: true,
      detailsSubmitted: true,
    };

    const updateSets: unknown[] = [];
    const db = fakeDb({
      // First select: stale stores. Second select: stale orders (empty).
      selectSequence: [[storeRow], []],
      onUpdate: (set) => updateSets.push(set),
    });

    const stripe = makeStripeStub({
      retrieveAccountStatus: async () => ({
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
      }),
    });

    const summary = await reconcile({ db, stripe });

    expect(summary.storesChecked).toBe(1);
    expect(summary.storesUpdated).toBe(1);
    expect(summary.errors).toBe(0);

    // The update must carry the correct flags.
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
  });

  it("does NOT update a store that is already fully enabled (query excludes it)", async () => {
    // A fully-enabled store is filtered OUT by the query's WHERE clause, so it
    // never appears in the select results. Simulate this by returning no stale
    // store rows for the first select.
    const updateSets: unknown[] = [];
    const db = fakeDb({
      selectSequence: [[], []], // no stale stores, no stale orders
      onUpdate: (set) => updateSets.push(set),
    });

    const stripe = makeStripeStub();

    const summary = await reconcile({ db, stripe });

    expect(summary.storesChecked).toBe(0);
    expect(summary.storesUpdated).toBe(0);
    expect(summary.errors).toBe(0);
    expect(updateSets).toHaveLength(0);
  });

  it("does NOT count an update when all flags already match Stripe (no actual change)", async () => {
    // Store says chargesEnabled=false; Stripe also says chargesEnabled=false.
    // No flags differ → no update should be issued and storesUpdated stays 0.
    const storeRow = {
      id: UUID_STORE_1,
      stripeConnectAccountId: STRIPE_ACCT_ID,
      chargesEnabled: false,
      payoutsEnabled: true,
      detailsSubmitted: true,
    };

    const updateSets: unknown[] = [];
    const db = fakeDb({
      selectSequence: [[storeRow], []],
      onUpdate: (set) => updateSets.push(set),
    });

    const stripe = makeStripeStub({
      // Stripe agrees with the DB — no actual change.
      retrieveAccountStatus: async () => ({
        chargesEnabled: false,
        payoutsEnabled: true,
        detailsSubmitted: true,
      }),
    });

    const summary = await reconcile({ db, stripe });

    expect(summary.storesChecked).toBe(1);
    expect(summary.storesUpdated).toBe(0);
    expect(updateSets).toHaveLength(0);
  });

  it("increments errors and continues when retrieveAccountStatus throws for one store", async () => {
    const storeRow1 = {
      id: UUID_STORE_1,
      stripeConnectAccountId: STRIPE_ACCT_ID,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    };
    const storeRow2 = {
      id: UUID_STORE_2,
      stripeConnectAccountId: "acct_other",
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    };

    const updateSets: unknown[] = [];
    const db = fakeDb({
      selectSequence: [[storeRow1, storeRow2], []],
      onUpdate: (set) => updateSets.push(set),
    });

    let callCount = 0;
    const stripe = makeStripeStub({
      retrieveAccountStatus: async (_accountId) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Stripe API error: rate limit");
        }
        // Second store succeeds.
        return { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
      },
    });

    const summary = await reconcile({ db, stripe });

    // Both stores were checked (2 Stripe calls attempted).
    expect(summary.storesChecked).toBe(2);
    // First store errored; second store succeeded and has different flags → updated.
    expect(summary.errors).toBe(1);
    expect(summary.storesUpdated).toBe(1);
    // The second store's update was recorded.
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Pass 2: Stale pending-payment order reconcile tests
// ---------------------------------------------------------------------------

describe("reconcile — stale pending-payment orders", () => {
  it("marks a stale pending_payment order as paid when PI status is succeeded", async () => {
    const orderRow = {
      id: UUID_ORDER_1,
      stripePaymentIntentId: STRIPE_PI_ID,
    };

    const updateSets: unknown[] = [];
    const db = fakeDb({
      // First select: no stale stores. Second select: one stale order.
      selectSequence: [[], [orderRow]],
      onUpdate: (set) => updateSets.push(set),
    });

    const stripe = makeStripeStub({
      retrievePaymentIntent: async () => ({ status: "succeeded" }),
    });

    const summary = await reconcile({ db, stripe });

    expect(summary.ordersChecked).toBe(1);
    expect(summary.ordersMarkedPaid).toBe(1);
    expect(summary.errors).toBe(0);

    // The update must set status=paid and updatedAt.
    expect(updateSets).toHaveLength(1);
    const set = updateSets[0] as { status: string; updatedAt: Date };
    expect(set.status).toBe("paid");
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it("does NOT mark an order as paid when PI status is requires_payment_method", async () => {
    const orderRow = {
      id: UUID_ORDER_1,
      stripePaymentIntentId: STRIPE_PI_ID,
    };

    const updateSets: unknown[] = [];
    const db = fakeDb({
      selectSequence: [[], [orderRow]],
      onUpdate: (set) => updateSets.push(set),
    });

    const stripe = makeStripeStub({
      retrievePaymentIntent: async () => ({ status: "requires_payment_method" }),
    });

    const summary = await reconcile({ db, stripe });

    expect(summary.ordersChecked).toBe(1);
    expect(summary.ordersMarkedPaid).toBe(0);
    // No update should have been issued.
    expect(updateSets).toHaveLength(0);
  });

  it("increments errors when retrievePaymentIntent throws; other orders still processed", async () => {
    const orderRow1 = { id: UUID_ORDER_1, stripePaymentIntentId: "pi_first" };
    const orderRow2 = {
      id: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44",
      stripePaymentIntentId: "pi_second",
    };

    const updateSets: unknown[] = [];
    const db = fakeDb({
      selectSequence: [[], [orderRow1, orderRow2]],
      onUpdate: (set) => updateSets.push(set),
    });

    let piCallCount = 0;
    const stripe = makeStripeStub({
      retrievePaymentIntent: async (_id) => {
        piCallCount++;
        if (piCallCount === 1) {
          throw new Error("Stripe API error: network timeout");
        }
        return { status: "succeeded" };
      },
    });

    const summary = await reconcile({ db, stripe });

    expect(summary.ordersChecked).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.ordersMarkedPaid).toBe(1);
    expect(updateSets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: both passes run in one reconcile() call
// ---------------------------------------------------------------------------

describe("reconcile — full run summary", () => {
  it("returns accurate combined summary for stores + orders", async () => {
    const storeRow = {
      id: UUID_STORE_1,
      stripeConnectAccountId: STRIPE_ACCT_ID,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    };
    const orderRow = {
      id: UUID_ORDER_1,
      stripePaymentIntentId: STRIPE_PI_ID,
    };

    const db = fakeDb({
      selectSequence: [[storeRow], [orderRow]],
    });

    const stripe = makeStripeStub({
      retrieveAccountStatus: async () => ({
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
      }),
      retrievePaymentIntent: async () => ({ status: "succeeded" }),
    });

    const summary = await reconcile({ db, stripe });

    expect(summary).toEqual({
      storesChecked: 1,
      storesUpdated: 1,
      ordersChecked: 1,
      ordersMarkedPaid: 1,
      errors: 0,
    });
  });

  it("respects staleAfterMinutes when provided (passes the value without throwing)", async () => {
    // Just verify the function accepts and uses a custom staleAfterMinutes without errors.
    const db = fakeDb({ selectSequence: [[], []] });
    const stripe = makeStripeStub();

    const summary = await reconcile({ db, stripe, staleAfterMinutes: 30 });

    expect(summary.storesChecked).toBe(0);
    expect(summary.ordersChecked).toBe(0);
    expect(summary.errors).toBe(0);
  });

  it("never throws even if both passes have individual item failures", async () => {
    const storeRow = {
      id: UUID_STORE_1,
      stripeConnectAccountId: STRIPE_ACCT_ID,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    };
    const orderRow = {
      id: UUID_ORDER_1,
      stripePaymentIntentId: STRIPE_PI_ID,
    };

    const db = fakeDb({ selectSequence: [[storeRow], [orderRow]] });

    const stripe = makeStripeStub({
      retrieveAccountStatus: async () => {
        throw new Error("account error");
      },
      retrievePaymentIntent: async () => {
        throw new Error("pi error");
      },
    });

    // reconcile() must NOT throw even when every Stripe call fails.
    await expect(reconcile({ db, stripe })).resolves.toMatchObject({
      storesChecked: 1,
      storesUpdated: 0,
      ordersChecked: 1,
      ordersMarkedPaid: 0,
      errors: 2,
    });
  });

  it("uses vi.fn() stubs and verifies call arguments", async () => {
    const storeRow = {
      id: UUID_STORE_1,
      stripeConnectAccountId: STRIPE_ACCT_ID,
      chargesEnabled: false,
      payoutsEnabled: true,
      detailsSubmitted: true,
    };
    const orderRow = {
      id: UUID_ORDER_1,
      stripePaymentIntentId: STRIPE_PI_ID,
    };

    const db = fakeDb({ selectSequence: [[storeRow], [orderRow]] });

    const retrieveAccountStatus = vi.fn().mockResolvedValue({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
    const retrievePaymentIntent = vi.fn().mockResolvedValue({ status: "succeeded" });

    await reconcile({ db, stripe: { retrieveAccountStatus, retrievePaymentIntent } });

    expect(retrieveAccountStatus).toHaveBeenCalledOnce();
    expect(retrieveAccountStatus).toHaveBeenCalledWith(STRIPE_ACCT_ID);

    expect(retrievePaymentIntent).toHaveBeenCalledOnce();
    expect(retrievePaymentIntent).toHaveBeenCalledWith(STRIPE_PI_ID);
  });
});
