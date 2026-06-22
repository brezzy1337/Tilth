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
 *   - Abandoned-PI sweeper: orders older than abandonAfterHours are cancelled.
 *   - pisCancelled increments only on successful cancelPaymentIntent calls.
 *   - Per-item resilience: one failing cancel does not abort the sweeper pass.
 *   - markOrderPaid is only counted when an actual row transitions (not on re-runs).
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
 *   - update().set().where() records calls, resolves to `updateResult` (default: [{}] so
 *     markOrderPaid returns true — 1 row affected).
 */
function fakeDb(opts: {
  /** Each call to db.select() returns the next array in this sequence. */
  selectSequence?: unknown[][];
  /** Fallback rows for all select calls when selectSequence is not provided. */
  selectRows?: unknown[];
  /** Called with the `set` argument of every update().set() call. */
  onUpdate?: (set: unknown) => void;
  /**
   * What the update chain resolves to. Default [{}] so markOrderPaid sees a
   * non-empty array and returns true (1 row transitioned).
   */
  updateResult?: unknown;
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

  // updateResult defaults to [{}] — a non-empty array — so that markOrderPaid
  // (which checks result.length > 0 after .returning()) returns true.
  const resolvedUpdateResult = opts.updateResult !== undefined ? opts.updateResult : [{}];

  const updateBuilder: {
    set: (s: unknown) => typeof updateBuilder;
    where: (...args: unknown[]) => typeof updateBuilder;
    returning: (...args: unknown[]) => Promise<unknown>;
    // Allow direct await on the builder (for update chains without .returning()).
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => void;
  } = {
    set: (s: unknown) => {
      opts.onUpdate?.(s);
      return updateBuilder;
    },
    where: () => updateBuilder,
    returning: () => Promise.resolve(resolvedUpdateResult),
    then: (resolve) => {
      Promise.resolve(resolvedUpdateResult).then(resolve);
    },
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

type StripeStub = Pick<StripeClient, "retrieveAccountStatus" | "retrievePaymentIntent" | "cancelPaymentIntent">;

function makeStripeStub(overrides: Partial<StripeStub> = {}): StripeStub {
  return {
    retrieveAccountStatus: async () => ({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    }),
    retrievePaymentIntent: async () => ({ status: "succeeded" }),
    cancelPaymentIntent: async () => ({ status: "canceled" }),
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
      // Three selects: stale stores, stale orders, abandoned orders (empty).
      selectSequence: [[storeRow], [], []],
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
      selectSequence: [[], [], []], // no stale stores, no stale orders, no abandoned
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
      selectSequence: [[storeRow], [], []],
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
      selectSequence: [[storeRow1, storeRow2], [], []],
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
      // First select: no stale stores. Second select: one stale order. Third: no abandoned.
      selectSequence: [[], [orderRow], []],
      onUpdate: (set) => updateSets.push(set),
      // updateResult non-empty so markOrderPaid returns true
      updateResult: [{}],
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

  it("does NOT increment ordersMarkedPaid when the row was already paid (markOrderPaid returns false)", async () => {
    // Simulate the case where the DB update affects 0 rows (already paid).
    const orderRow = {
      id: UUID_ORDER_1,
      stripePaymentIntentId: STRIPE_PI_ID,
    };

    const db = fakeDb({
      selectSequence: [[], [orderRow], []],
      // updateResult empty → markOrderPaid returns false → no increment
      updateResult: [],
    });

    const stripe = makeStripeStub({
      retrievePaymentIntent: async () => ({ status: "succeeded" }),
    });

    const summary = await reconcile({ db, stripe });

    expect(summary.ordersChecked).toBe(1);
    // markOrderPaid returned false (0 rows affected) → count stays 0
    expect(summary.ordersMarkedPaid).toBe(0);
    expect(summary.errors).toBe(0);
  });

  it("does NOT mark an order as paid when PI status is requires_payment_method", async () => {
    const orderRow = {
      id: UUID_ORDER_1,
      stripePaymentIntentId: STRIPE_PI_ID,
    };

    const updateSets: unknown[] = [];
    const db = fakeDb({
      selectSequence: [[], [orderRow], []],
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
      selectSequence: [[], [orderRow1, orderRow2], []],
      onUpdate: (set) => updateSets.push(set),
      updateResult: [{}],
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
// Pass 3: Abandoned-PI sweeper tests
// ---------------------------------------------------------------------------

describe("reconcile — abandoned-PI sweeper", () => {
  it("calls cancelPaymentIntent for each abandoned order and counts pisCancelled", async () => {
    const abandonedOrder1 = { id: UUID_ORDER_1, stripePaymentIntentId: "pi_abandoned_1" };
    const abandonedOrder2 = {
      id: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44",
      stripePaymentIntentId: "pi_abandoned_2",
    };

    const cancelledPiIds: string[] = [];
    const db = fakeDb({
      // stores: empty, stale orders: empty, abandoned orders: 2
      selectSequence: [[], [], [abandonedOrder1, abandonedOrder2]],
    });

    const stripe = makeStripeStub({
      cancelPaymentIntent: async (id) => {
        cancelledPiIds.push(id);
        return { status: "canceled" };
      },
    });

    const summary = await reconcile({ db, stripe });

    expect(summary.pisCancelled).toBe(2);
    expect(cancelledPiIds).toEqual(["pi_abandoned_1", "pi_abandoned_2"]);
    expect(summary.errors).toBe(0);
  });

  it("does NOT set order status — the webhook is the source of truth", async () => {
    // The sweeper should call cancelPaymentIntent but not call db.update for the order.
    const abandonedOrder = { id: UUID_ORDER_1, stripePaymentIntentId: "pi_abandoned_1" };

    const updateSets: unknown[] = [];
    const db = fakeDb({
      selectSequence: [[], [], [abandonedOrder]],
      onUpdate: (set) => updateSets.push(set),
    });

    const stripe = makeStripeStub();

    await reconcile({ db, stripe });

    // No update should be issued for order status in the sweeper pass.
    expect(updateSets).toHaveLength(0);
  });

  it("counts pisCancelled only for successful cancels (per-item resilience)", async () => {
    const abandonedOrder1 = { id: UUID_ORDER_1, stripePaymentIntentId: "pi_fail" };
    const abandonedOrder2 = {
      id: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44",
      stripePaymentIntentId: "pi_ok",
    };

    const db = fakeDb({
      selectSequence: [[], [], [abandonedOrder1, abandonedOrder2]],
    });

    let cancelCount = 0;
    const stripe = makeStripeStub({
      cancelPaymentIntent: async (id) => {
        cancelCount++;
        if (id === "pi_fail") throw new Error("Stripe: PI already in terminal state");
        return { status: "canceled" };
      },
    });

    const summary = await reconcile({ db, stripe });

    // One success, one error — each counted correctly.
    expect(summary.pisCancelled).toBe(1);
    expect(summary.errors).toBe(1);
  });

  it("respects abandonAfterHours parameter (passes without throwing)", async () => {
    const db = fakeDb({ selectSequence: [[], [], []] });
    const stripe = makeStripeStub();

    const summary = await reconcile({ db, stripe, abandonAfterHours: 48 });

    expect(summary.pisCancelled).toBe(0);
    expect(summary.errors).toBe(0);
  });

  it("Pass 2/Pass 3 windows are disjoint: an abandoned order is swept (Pass 3) and NOT reconciled (Pass 2)", async () => {
    // The fake DB returns the abandoned order ONLY in the third select (Pass 3).
    // Pass 2's select (second call) returns empty — simulating the lower-bound
    // SQL filter that excludes orders older than abandonAfterHours.
    // This verifies the contract: retrievePaymentIntent is never called for an
    // abandoned order; cancelPaymentIntent IS called.
    const abandonedOrder = { id: UUID_ORDER_1, stripePaymentIntentId: "pi_abandoned_old" };

    const retrievePaymentIntent = vi.fn().mockResolvedValue({ status: "succeeded" });
    const cancelPaymentIntent = vi.fn().mockResolvedValue({ status: "canceled" });

    const db = fakeDb({
      // stores: empty | Pass 2 (stale): empty | Pass 3 (abandoned): one order
      selectSequence: [[], [], [abandonedOrder]],
    });

    await reconcile({
      db,
      stripe: makeStripeStub({ retrievePaymentIntent, cancelPaymentIntent }),
    });

    // Pass 2 must NOT have fetched the PI (the order is in Pass 3's exclusive window).
    expect(retrievePaymentIntent).not.toHaveBeenCalled();

    // Pass 3 must have cancelled the PI.
    expect(cancelPaymentIntent).toHaveBeenCalledOnce();
    expect(cancelPaymentIntent).toHaveBeenCalledWith("pi_abandoned_old");
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
      selectSequence: [[storeRow], [orderRow], []],
      updateResult: [{}],
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
      pisCancelled: 0,
      errors: 0,
    });
  });

  it("respects staleAfterMinutes when provided (passes the value without throwing)", async () => {
    // Just verify the function accepts and uses a custom staleAfterMinutes without errors.
    const db = fakeDb({ selectSequence: [[], [], []] });
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

    const db = fakeDb({ selectSequence: [[storeRow], [orderRow], []] });

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
      pisCancelled: 0,
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

    const db = fakeDb({
      selectSequence: [[storeRow], [orderRow], []],
      updateResult: [{}],
    });

    const retrieveAccountStatus = vi.fn().mockResolvedValue({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
    const retrievePaymentIntent = vi.fn().mockResolvedValue({ status: "succeeded" });
    const cancelPaymentIntent = vi.fn().mockResolvedValue({ status: "canceled" });

    await reconcile({ db, stripe: { retrieveAccountStatus, retrievePaymentIntent, cancelPaymentIntent } });

    expect(retrieveAccountStatus).toHaveBeenCalledOnce();
    expect(retrieveAccountStatus).toHaveBeenCalledWith(STRIPE_ACCT_ID);

    expect(retrievePaymentIntent).toHaveBeenCalledOnce();
    expect(retrievePaymentIntent).toHaveBeenCalledWith(STRIPE_PI_ID);

    // No abandoned orders in this test — cancelPaymentIntent should not be called.
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });
});
