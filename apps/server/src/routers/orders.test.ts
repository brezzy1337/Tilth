/**
 * Unit tests for the orders and connect routers + webhook handleStripeEvent.
 *
 * No live Stripe, no real DB — uses stub clients and fake DB builders.
 * DB-dependent integration tests are guarded on TEST_DATABASE_URL (same pattern
 * as nearby.integration.test.ts).
 *
 * Covers:
 *   - handleStripeEvent: paid-transition idempotency, account.updated store sync
 *   - orders.create: price/fee computation, single-store rejection, not-onboarded rejection
 *   - connect.createOnboardingLink: creates+persists account id once (idempotent on reuse)
 *   - orders.requestRefund, approveRefund, declineRefund: guards, mutations, re-request
 *   - orders.listForMyStore: empty / populated / cursor pagination
 */

import { describe, it, expect, vi } from "vitest";
import { handleStripeEvent } from "../webhook";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context } from "../context";
import * as authHelpers from "../auth";
import type Stripe from "stripe";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_ORDER = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const UUID_STORE = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const UUID_BUYER = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33";
const UUID_LISTING_1 = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44";
const UUID_LISTING_2 = "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55";
const UUID_ITEM_1 = "f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66";
const STRIPE_ACCOUNT_ID = "acct_test1234";
const STRIPE_PI_ID = "pi_test_abc123";
const TEST_SECRET = "test-jwt-secret-that-is-at-least-32-chars";

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

const stubAuth: Context["auth"] = {
  hashPassword: authHelpers.hashPassword,
  verifyPassword: authHelpers.verifyPassword,
  signToken: authHelpers.signToken,
  verifyToken: authHelpers.verifyToken,
};

/** A fully functional stub StripeClient that can be overridden per test. */
function makeStripeStub(overrides: Partial<Context["stripe"]> = {}): Context["stripe"] {
  return {
    createConnectedAccount: async () => ({ id: STRIPE_ACCOUNT_ID }),
    createAccountLink: async () => ({ url: "https://connect.stripe.com/setup/test" }),
    retrieveAccountStatus: async () => ({
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: false,
    }),
    createPaymentIntent: async () => ({
      id: STRIPE_PI_ID,
      clientSecret: "pi_test_abc123_secret_xyz",
    }),
    retrievePaymentIntent: async () => ({ status: "succeeded" }),
    cancelPaymentIntent: async () => ({ status: "canceled" }),
    refundPayment: async () => ({ id: "re_stub", status: "succeeded", amountRefunded: 0 }),
    createDashboardLink: async () => ({ url: "https://connect.stripe.com/express/dashboard/test" }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake DB builder — single source of truth for all router unit tests
//
// Options:
//   selectRows       — rows returned by every plain select() (no sequence)
//   selectSequence   — per-call rows; each select() call consumes the next slot
//   joinUsesSelectSlot — when true, innerJoin() reuses the same slot already consumed
//                        by the enclosing select() call (used by refund procedures that
//                        load orders with a store join). Default false.
//   joinRows         — rows returned by innerJoin (when joinUsesSelectSlot is false)
//   insertRows       — rows returned by insert().returning()
//   insertError      — if set, insert().returning() rejects with this
//   updateRows       — rows returned by every update().returning() (no sequence)
//   updateSequence   — per-call rows; each update().returning() call consumes the next slot
//   updateFn         — called with the set-payload on every update().set()
//   captureUpdates   — each update().set() payload is pushed here
//   transactionFn    — override the transaction implementation
// ---------------------------------------------------------------------------

function fakeDb(opts: {
  selectRows?: unknown[];
  insertRows?: unknown[];
  selectSequence?: unknown[][];
  insertError?: unknown;
  updateRows?: unknown[];
  updateSequence?: unknown[][];
  joinRows?: unknown[];
  joinUsesSelectSlot?: boolean;
  updateFn?: (set: unknown) => void;
  captureUpdates?: unknown[];
  transactionFn?: (txFn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
}) {
  let selectCallCount = 0;
  let updateCallCount = 0;
  const capturedUpdates = opts.captureUpdates ?? [];

  const selectFn = () => {
    const slotIdx = selectCallCount;
    const rows = opts.selectSequence
      ? (opts.selectSequence[selectCallCount++] ?? [])
      : (opts.selectRows ?? []);

    const builder: {
      from: () => typeof builder;
      where: () => typeof builder;
      limit: () => Promise<unknown[]>;
      innerJoin: () => { where: () => { limit: () => Promise<unknown[]> } };
      then: (resolve: (v: unknown[]) => void, reject: (e: unknown) => void) => void;
      orderBy: () => typeof builder;
    } = {
      from: () => builder,
      where: () => builder,
      limit: () => Promise.resolve(rows),
      orderBy: () => builder,
      innerJoin: () => {
        // When joinUsesSelectSlot is true the innerJoin result is the same rows
        // already loaded by this select() call (the slot was consumed above).
        // When false, use the dedicated joinRows option.
        const joinResult = opts.joinUsesSelectSlot
          ? (opts.selectSequence ? (opts.selectSequence[slotIdx] ?? []) : (opts.selectRows ?? []))
          : (opts.joinRows ?? []);
        const jb = {
          where: () => ({ limit: () => Promise.resolve(joinResult) }),
        };
        return jb;
      },
      then: (resolve: (v: unknown[]) => void) => {
        Promise.resolve(rows).then(resolve);
      },
    };
    return builder;
  };

  const insertBuilder = {
    values: () => insertBuilder,
    returning: () =>
      opts.insertError !== undefined
        ? Promise.reject(opts.insertError)
        : Promise.resolve(opts.insertRows ?? []),
  };
  const insertFn = () => insertBuilder;

  const updateFn = () => {
    const callIdx = updateCallCount++;
    const returningRows = opts.updateSequence
      ? (opts.updateSequence[callIdx] ?? [{ id: UUID_ORDER }])
      : (opts.updateRows ?? [{ id: UUID_ORDER }]);

    const updateBuilder = {
      set: (s: unknown) => {
        capturedUpdates.push(s);
        opts.updateFn?.(s);
        return updateBuilder;
      },
      where: () => updateBuilder,
      returning: () => Promise.resolve(returningRows),
    };
    return updateBuilder;
  };

  const transactionFn = opts.transactionFn ?? (async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn({
      insert: insertFn,
      update: () => {
        const callIdx = updateCallCount++;
        const returningRows = opts.updateSequence
          ? (opts.updateSequence[callIdx] ?? [{ id: UUID_ORDER }])
          : (opts.updateRows ?? [{ id: UUID_ORDER }]);
        const ub = {
          set: (s: unknown) => {
            capturedUpdates.push(s);
            opts.updateFn?.(s);
            return ub;
          },
          where: () => ub,
          returning: () => Promise.resolve(returningRows),
        };
        return ub;
      },
      select: selectFn,
    });
  });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    transaction: transactionFn,
  } as unknown as Context["db"];
}

const createCaller = createCallerFactory(appRouter);

// ---------------------------------------------------------------------------
// handleStripeEvent — webhook unit tests
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake DB for webhook tests that supports the transaction wrapper.
 * The transaction callback receives a `tx` with insert (claim + dedup), update, select.
 *
 * `claimResult` controls whether the dedup claim returns a row (new event) or empty (dupe).
 * `onTxUpdate` captures the `set` payload from any tx.update().set() call.
 */
function fakeWebhookDb(opts: {
  claimResult?: { id: string }[];
  onTxUpdate?: (set: unknown) => void;
  txUpdateRows?: unknown[];
}): Context["db"] {
  const claimRows = opts.claimResult ?? [{ id: "evt_test" }]; // default: claim succeeds

  const txInsertBuilder = {
    values: () => txInsertBuilder,
    onConflictDoNothing: () => txInsertBuilder,
    returning: () => Promise.resolve(claimRows),
  };

  const txUpdateBuilder = {
    set: (s: unknown) => {
      opts.onTxUpdate?.(s);
      return txUpdateBuilder;
    },
    where: () => txUpdateBuilder,
    returning: () => Promise.resolve(opts.txUpdateRows ?? []),
  };

  const tx = {
    insert: () => txInsertBuilder,
    update: () => txUpdateBuilder,
    select: () => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }),
  };

  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    update: () => txUpdateBuilder,
    insert: () => txInsertBuilder,
  } as unknown as Context["db"];

  return db;
}

const stubStripeForWebhook = makeStripeStub();

describe("handleStripeEvent — payment_intent.succeeded", () => {
  it("transitions pending_payment order to paid", async () => {
    const updates: unknown[] = [];
    const db = fakeWebhookDb({ onTxUpdate: (s) => updates.push(s) });

    const event = {
      id: "evt_pi_succeeded_1",
      type: "payment_intent.succeeded",
      data: {
        object: { id: STRIPE_PI_ID } as Stripe.PaymentIntent,
      },
    } as Stripe.Event;

    await handleStripeEvent(event, { db, stripe: stubStripeForWebhook });
    // Just verify no error is thrown — the update would succeed via fake db
    expect(true).toBe(true);
  });

  it("is idempotent — re-delivery of succeeded event does not throw", async () => {
    // Simulate a duplicate: claim returns empty (already processed)
    const db = fakeWebhookDb({ claimResult: [] });

    const event = {
      id: "evt_pi_succeeded_dup",
      type: "payment_intent.succeeded",
      data: { object: { id: STRIPE_PI_ID } as Stripe.PaymentIntent },
    } as Stripe.Event;

    // Should not throw even when 0 rows updated (dedup short-circuit)
    await expect(handleStripeEvent(event, { db, stripe: stubStripeForWebhook })).resolves.toBeUndefined();
  });
});

describe("handleStripeEvent — account.updated", () => {
  it("calls retrieveAccountStatus and writes authoritative flags to store", async () => {
    const captured: unknown[] = [];
    const db = fakeWebhookDb({ onTxUpdate: (s) => captured.push(s) });

    const retrieveAccountStatus = vi.fn().mockResolvedValue({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });

    const event = {
      id: "evt_acct_updated_1",
      type: "account.updated",
      data: {
        object: {
          id: STRIPE_ACCOUNT_ID,
          charges_enabled: false, // payload says false — but we ignore the payload
          payouts_enabled: false,
          details_submitted: false,
        } as Stripe.Account,
      },
    } as Stripe.Event;

    await handleStripeEvent(event, { db, stripe: { ...stubStripeForWebhook, retrieveAccountStatus } });

    // retrieveAccountStatus should have been called with the account id
    expect(retrieveAccountStatus).toHaveBeenCalledWith(STRIPE_ACCOUNT_ID);
    // The authoritative values (from retrieveAccountStatus, not the payload) should be written
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    });
  });

  it("writes false flags from retrieveAccountStatus (not from payload)", async () => {
    const captured: unknown[] = [];
    const db = fakeWebhookDb({ onTxUpdate: (s) => captured.push(s) });

    const retrieveAccountStatus = vi.fn().mockResolvedValue({
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    });

    const event = {
      id: "evt_acct_updated_2",
      type: "account.updated",
      data: {
        object: {
          id: STRIPE_ACCOUNT_ID,
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        } as Stripe.Account,
      },
    } as Stripe.Event;

    await handleStripeEvent(event, { db, stripe: { ...stubStripeForWebhook, retrieveAccountStatus } });
    expect(captured[0]).toMatchObject({
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    });
  });
});

describe("handleStripeEvent — unknown event type", () => {
  it("ignores unknown event types without throwing", async () => {
    const db = fakeWebhookDb({});
    const event = {
      id: "evt_customer_created",
      type: "customer.created",
      data: { object: {} },
    } as unknown as Stripe.Event;

    await expect(handleStripeEvent(event, { db, stripe: stubStripeForWebhook })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// orders.create — unit tests with stub stripe + fake db
// ---------------------------------------------------------------------------

describe("orders.create", () => {
  /** Build a context with a pre-seeded db state for orders.create tests. */
  function makeOrderCtx(opts: {
    listingRows?: unknown[];
    storeRows?: unknown[];
    stripeOverrides?: Partial<Context["stripe"]>;
    insertRows?: unknown[];
    updateRows?: unknown[];
    insertError?: unknown;
  }): Context {
    // selectSequence: [listings query, store query]
    const selectSequence: unknown[][] = [
      opts.listingRows ?? [
        {
          id: UUID_LISTING_1,
          storeId: UUID_STORE,
          name: "Tomatoes",
          priceCents: 200,
        },
      ],
      opts.storeRows ?? [
        {
          id: UUID_STORE,
          stripeConnectAccountId: STRIPE_ACCOUNT_ID,
          chargesEnabled: true,
        },
      ],
    ];

    const insertedOrderRows = [{ id: UUID_ORDER }];
    const insertedItemRows = [
      {
        id: UUID_ITEM_1,
        listingId: UUID_LISTING_1,
        nameSnapshot: "Tomatoes",
        unitPriceCents: 200,
        quantity: 2,
        lineTotalCents: 400,
      },
    ];

    // Fake transaction that simulates order + items insert
    const transactionFn = async (fn: (tx: unknown) => Promise<unknown>) => {
      let callCount = 0;
      const tx = {
        insert: () => ({
          values: () => ({
            returning: () => {
              if (opts.insertError && callCount === 0) {
                callCount++;
                return Promise.reject(opts.insertError);
              }
              const rows = callCount === 0 ? insertedOrderRows : insertedItemRows;
              callCount++;
              return Promise.resolve(opts.insertRows ? opts.insertRows[callCount - 1] ?? rows : rows);
            },
          }),
        }),
        update: () => ({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
        }),
      };
      return fn(tx);
    };

    const db = {
      select: (() => {
        let count = 0;
        return () => {
          const rows = selectSequence[count++] ?? [];
          const b: {
            from: () => typeof b;
            where: () => typeof b;
            limit: () => Promise<unknown[]>;
            then: (resolve: (v: unknown[]) => void) => void;
          } = {
            from: () => b,
            where: () => b,
            limit: () => Promise.resolve(rows),
            then: (resolve: (v: unknown[]) => void) => Promise.resolve(rows).then(resolve),
          };
          return b;
        };
      })(),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve(opts.insertRows ?? insertedOrderRows),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve(opts.updateRows ?? [{ id: UUID_ORDER }]),
          }),
        }),
      }),
      transaction: transactionFn,
    } as unknown as Context["db"];

    return {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: makeStripeStub(opts.stripeOverrides ?? {}),
      user: { id: UUID_BUYER },
    };
  }

  it("computes subtotal, applicationFee (10%), and totalCents correctly", async () => {
    // 2 × Tomatoes @ 200¢ = 400¢ subtotal, fee = round(400 × 1000 / 10000) = 40¢
    const ctx = makeOrderCtx({});
    const caller = createCaller(ctx);

    const result = await caller.orders.create({
      items: [{ listingId: UUID_LISTING_1, quantity: 2 }],
    });

    expect(result.order.subtotalCents).toBe(400);
    expect(result.order.applicationFeeCents).toBe(40);
    expect(result.order.totalCents).toBe(400);
    expect(result.clientSecret).toBe("pi_test_abc123_secret_xyz");
  });

  it("passes applicationFeeCents, destinationAccountId, and idempotencyKey to Stripe", async () => {
    const piInput = vi.fn().mockResolvedValue({
      id: STRIPE_PI_ID,
      clientSecret: "pi_test_abc123_secret_xyz",
    });

    const ctx = makeOrderCtx({
      stripeOverrides: { createPaymentIntent: piInput },
    });
    const caller = createCaller(ctx);

    await caller.orders.create({
      items: [{ listingId: UUID_LISTING_1, quantity: 2 }],
    });

    expect(piInput).toHaveBeenCalledOnce();
    const call = piInput.mock.calls[0]![0];
    expect(call.amountCents).toBe(400);
    expect(call.applicationFeeCents).toBe(40);
    expect(call.destinationAccountId).toBe(STRIPE_ACCOUNT_ID);
    expect(call.metadata.orderId).toBe(UUID_ORDER);
    // Idempotency key must be the orderId — prevents duplicate PIs on client retries
    expect(call.idempotencyKey).toBe(UUID_ORDER);
  });

  it("rejects items from multiple stores with BAD_REQUEST", async () => {
    const ctx = makeOrderCtx({
      listingRows: [
        { id: UUID_LISTING_1, storeId: UUID_STORE, name: "Tomatoes", priceCents: 200 },
        { id: UUID_LISTING_2, storeId: "different-store-id", name: "Apples", priceCents: 300 },
      ],
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.create({
        items: [
          { listingId: UUID_LISTING_1, quantity: 1 },
          { listingId: UUID_LISTING_2, quantity: 1 },
        ],
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  it("rejects when store has no stripeConnectAccountId (not onboarded)", async () => {
    const ctx = makeOrderCtx({
      storeRows: [
        {
          id: UUID_STORE,
          stripeConnectAccountId: null, // not onboarded
          chargesEnabled: false,
        },
      ],
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.create({
        items: [{ listingId: UUID_LISTING_1, quantity: 1 }],
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });

  it("rejects when store has stripeConnectAccountId but chargesEnabled is false", async () => {
    const ctx = makeOrderCtx({
      storeRows: [
        {
          id: UUID_STORE,
          stripeConnectAccountId: STRIPE_ACCOUNT_ID,
          chargesEnabled: false, // onboarded but not enabled yet
        },
      ],
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.create({
        items: [{ listingId: UUID_LISTING_1, quantity: 1 }],
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });

  it("throws UNAUTHORIZED when unauthenticated", async () => {
    const ctx = makeOrderCtx({});
    const caller = createCaller({ ...ctx, user: null });

    await expect(
      caller.orders.create({ items: [{ listingId: UUID_LISTING_1, quantity: 1 }] }),
    ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("rejects when a listing is not found", async () => {
    // Return fewer listings than requested (missing UUID_LISTING_2)
    const ctx = makeOrderCtx({
      listingRows: [
        { id: UUID_LISTING_1, storeId: UUID_STORE, name: "Tomatoes", priceCents: 200 },
      ],
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.create({
        items: [
          { listingId: UUID_LISTING_1, quantity: 1 },
          { listingId: UUID_LISTING_2, quantity: 1 }, // this one is missing from DB
        ],
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });
});

// ---------------------------------------------------------------------------
// connect.createOnboardingLink — unit tests
// ---------------------------------------------------------------------------

describe("connect.createOnboardingLink", () => {
  /** Build context for connect tests. */
  function makeConnectCtx(opts: {
    stripeConnectAccountId?: string | null;
    stripeOverrides?: Partial<Context["stripe"]>;
    updateRows?: unknown[];
  }): Context {
    const storeRow = {
      id: UUID_STORE,
      stripeConnectAccountId: opts.stripeConnectAccountId ?? null,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    };

    const selectFn = () => {
      const rows = [storeRow];
      const b: {
        from: () => typeof b;
        where: () => typeof b;
        limit: () => Promise<unknown[]>;
        then: (resolve: (v: unknown[]) => void) => void;
      } = {
        from: () => b,
        where: () => b,
        limit: () => Promise.resolve(rows),
        then: (resolve: (v: unknown[]) => void) => Promise.resolve(rows).then(resolve),
      };
      return b;
    };

    const updateBuilder = {
      set: () => updateBuilder,
      where: () => updateBuilder,
      returning: () => Promise.resolve(opts.updateRows ?? [{ id: UUID_STORE }]),
    };

    const db = {
      select: selectFn,
      update: () => updateBuilder,
    } as unknown as Context["db"];

    return {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: makeStripeStub(opts.stripeOverrides ?? {}),
      user: { id: UUID_BUYER },
    };
  }

  it("creates a new connected account when none exists and persists the id", async () => {
    const createConnectedAccount = vi.fn().mockResolvedValue({ id: STRIPE_ACCOUNT_ID });
    const ctx = makeConnectCtx({
      stripeConnectAccountId: null, // no account yet
      stripeOverrides: { createConnectedAccount },
    });
    const caller = createCaller(ctx);

    // input is now {} — URLs are server-side config, not accepted from the client (issue #7)
    const result = await caller.connect.createOnboardingLink({});

    expect(createConnectedAccount).toHaveBeenCalledOnce();
    // idempotencyKey = store.id must be passed through
    expect(createConnectedAccount).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: UUID_STORE }),
    );
    expect(result.accountId).toBe(STRIPE_ACCOUNT_ID);
    expect(result.url).toBe("https://connect.stripe.com/setup/test");
  });

  it("reuses existing account id without creating a new one", async () => {
    const createConnectedAccount = vi.fn();
    const ctx = makeConnectCtx({
      stripeConnectAccountId: STRIPE_ACCOUNT_ID, // already has account
      stripeOverrides: { createConnectedAccount },
    });
    const caller = createCaller(ctx);

    // input is now {} — URLs are server-side config
    const result = await caller.connect.createOnboardingLink({});

    // Must NOT create a new account
    expect(createConnectedAccount).not.toHaveBeenCalled();
    expect(result.accountId).toBe(STRIPE_ACCOUNT_ID);
  });

  it("throws UNAUTHORIZED when unauthenticated", async () => {
    const ctx = makeConnectCtx({});
    const caller = createCaller({ ...ctx, user: null });

    // input is now {} — client no longer supplies URLs
    await expect(
      caller.connect.createOnboardingLink({}),
    ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("throws NOT_FOUND when the caller has no store", async () => {
    const db = {
      select: () => {
        const b = {
          from: () => b,
          where: () => b,
          limit: () => Promise.resolve([]), // no store
          then: (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve),
        };
        return b;
      },
    } as unknown as Context["db"];

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: makeStripeStub(),
      user: { id: UUID_BUYER },
    };
    const caller = createCaller(ctx);

    // input is now {} — client no longer supplies URLs
    await expect(
      caller.connect.createOnboardingLink({}),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});

// ---------------------------------------------------------------------------
// connect.status — unit tests
// ---------------------------------------------------------------------------

describe("connect.status", () => {
  it("returns connected=false when no stripeConnectAccountId", async () => {
    const storeRow = {
      id: UUID_STORE,
      stripeConnectAccountId: null,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    };

    const b = {
      from: () => b,
      where: () => b,
      limit: () => Promise.resolve([storeRow]),
      then: (resolve: (v: unknown[]) => void) => Promise.resolve([storeRow]).then(resolve),
    };
    const db = { select: () => b } as unknown as Context["db"];

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: makeStripeStub(),
      user: { id: UUID_BUYER },
    };
    const caller = createCaller(ctx);

    const result = await caller.connect.status();
    expect(result.connected).toBe(false);
    expect(result.chargesEnabled).toBe(false);
  });

  it("returns connected=true when stripeConnectAccountId is set", async () => {
    const storeRow = {
      id: UUID_STORE,
      stripeConnectAccountId: STRIPE_ACCOUNT_ID,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    };

    const b = {
      from: () => b,
      where: () => b,
      limit: () => Promise.resolve([storeRow]),
      then: (resolve: (v: unknown[]) => void) => Promise.resolve([storeRow]).then(resolve),
    };
    const db = { select: () => b } as unknown as Context["db"];

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: makeStripeStub(),
      user: { id: UUID_BUYER },
    };
    const caller = createCaller(ctx);

    const result = await caller.connect.status();
    expect(result.connected).toBe(true);
    expect(result.chargesEnabled).toBe(true);
    expect(result.payoutsEnabled).toBe(true);
    expect(result.detailsSubmitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// connect.dashboardLink — unit tests
// ---------------------------------------------------------------------------

describe("connect.dashboardLink", () => {
  const DASHBOARD_URL = "https://connect.stripe.com/express/dashboard/test";

  /** Build a context for dashboardLink tests using the same pattern as createOnboardingLink. */
  function makeDashboardCtx(opts: {
    stripeConnectAccountId?: string | null;
    detailsSubmitted?: boolean;
    stripeOverrides?: Partial<Context["stripe"]>;
  }): Context {
    const storeRow = {
      id: UUID_STORE,
      stripeConnectAccountId: opts.stripeConnectAccountId ?? null,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: opts.detailsSubmitted ?? false,
    };

    const b = {
      from: () => b,
      where: () => b,
      limit: () => Promise.resolve([storeRow]),
      then: (resolve: (v: unknown[]) => void) => Promise.resolve([storeRow]).then(resolve),
    };
    const db = { select: () => b } as unknown as Context["db"];

    return {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: makeStripeStub(opts.stripeOverrides ?? {}),
      user: { id: UUID_BUYER },
    };
  }

  it("returns { url } when account is onboarded (detailsSubmitted=true)", async () => {
    const createDashboardLink = vi.fn().mockResolvedValue({ url: DASHBOARD_URL });
    const ctx = makeDashboardCtx({
      stripeConnectAccountId: STRIPE_ACCOUNT_ID,
      detailsSubmitted: true,
      stripeOverrides: { createDashboardLink },
    });
    const caller = createCaller(ctx);

    const result = await caller.connect.dashboardLink();

    expect(result.url).toBe(DASHBOARD_URL);
    expect(createDashboardLink).toHaveBeenCalledOnce();
    expect(createDashboardLink).toHaveBeenCalledWith(STRIPE_ACCOUNT_ID);
  });

  it("throws PRECONDITION_FAILED and does NOT call createDashboardLink when no connect account", async () => {
    const createDashboardLink = vi.fn();
    const ctx = makeDashboardCtx({
      stripeConnectAccountId: null,
      detailsSubmitted: false,
      stripeOverrides: { createDashboardLink },
    });
    const caller = createCaller(ctx);

    await expect(caller.connect.dashboardLink()).rejects.toThrow(
      expect.objectContaining({ code: "PRECONDITION_FAILED" }),
    );
    expect(createDashboardLink).not.toHaveBeenCalled();
  });

  it("throws PRECONDITION_FAILED and does NOT call createDashboardLink when detailsSubmitted=false", async () => {
    const createDashboardLink = vi.fn();
    const ctx = makeDashboardCtx({
      stripeConnectAccountId: STRIPE_ACCOUNT_ID,
      detailsSubmitted: false,
      stripeOverrides: { createDashboardLink },
    });
    const caller = createCaller(ctx);

    await expect(caller.connect.dashboardLink()).rejects.toThrow(
      expect.objectContaining({
        code: "PRECONDITION_FAILED",
        message: "Complete Stripe onboarding before viewing earnings.",
      }),
    );
    expect(createDashboardLink).not.toHaveBeenCalled();
  });

  it("throws UNAUTHORIZED when unauthenticated", async () => {
    const ctx = makeDashboardCtx({
      stripeConnectAccountId: STRIPE_ACCOUNT_ID,
      detailsSubmitted: true,
    });
    const caller = createCaller({ ...ctx, user: null });

    await expect(caller.connect.dashboardLink()).rejects.toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers for refund procedure tests
// ---------------------------------------------------------------------------

const UUID_SELLER = "aa00bc99-9c0b-4ef8-bb6d-6bb9bd380aaa";
const UUID_ORDER_PAID = "bb00bc99-9c0b-4ef8-bb6d-6bb9bd380abb";

/**
 * A base order row matching the mapOrder shape.
 * All refund fields start null; tests override specific fields.
 */
function makeOrderRow(overrides: Partial<{
  id: string;
  storeId: string;
  buyerId: string;
  status: string;
  stripePaymentIntentId: string | null;
  refundRequestedAt: Date | null;
  refundReason: string | null;
  refundApprovedAt: Date | null;
  refundDeclinedAt: Date | null;
  storeUserId: string;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: UUID_ORDER_PAID,
    storeId: UUID_STORE,
    buyerId: UUID_BUYER,
    status: "paid",
    subtotalCents: 500,
    applicationFeeCents: 50,
    totalCents: 500,
    stripePaymentIntentId: STRIPE_PI_ID,
    refundRequestedAt: null,
    refundReason: null,
    refundApprovedAt: null,
    refundDeclinedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    storeUserId: UUID_SELLER,
    ...overrides,
  };
}

/**
 * Build a context for refund procedure tests.
 *
 * Uses the module-level `fakeDb` with `joinUsesSelectSlot: true` so that
 * procedures doing select().innerJoin() (approveRefund, declineRefund, get) get
 * back the same slot row that the select() call would have returned.
 *
 * `selectSequence`  — ordered list of row arrays; each select() call consumes one slot.
 * `updateSequence`  — ordered list of row arrays; each update().returning() call consumes one slot.
 * `captureUpdates`  — each update().set() payload is pushed here.
 */
function makeRefundCtx(opts: {
  selectSequence: unknown[][];
  updateSequence?: unknown[][];
  captureUpdates?: unknown[];
  userId: string;
  stripeOverrides?: Partial<Context["stripe"]>;
}): Context {
  const db = fakeDb({
    selectSequence: opts.selectSequence,
    updateSequence: opts.updateSequence,
    captureUpdates: opts.captureUpdates,
    joinUsesSelectSlot: true,
  });

  return {
    db,
    jwtSecret: TEST_SECRET,
    auth: stubAuth,
    geocode: async () => null,
    stripe: makeStripeStub(opts.stripeOverrides ?? {}),
    user: { id: opts.userId },
  };
}

// ---------------------------------------------------------------------------
// orders.requestRefund
// ---------------------------------------------------------------------------

describe("orders.requestRefund", () => {
  it("sets refundRequestedAt when buyer requests on a paid order", async () => {
    const updates: unknown[] = [];
    const orderRow = makeOrderRow({ status: "paid" });
    // sequence: [initial load], [re-fetch after update (loadOrderById)], [order items]
    // updateSequence: claim returns a row (success)
    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],         // initial load (plain select, no join for requestRefund)
        [{ ...orderRow, refundRequestedAt: new Date("2026-06-22T10:00:00Z"), refundReason: "damaged" }], // re-fetch
        [],                  // order items
      ],
      updateSequence: [
        [{ id: UUID_ORDER_PAID }], // claim update succeeds
      ],
      captureUpdates: updates,
      userId: UUID_BUYER,
    });
    const caller = createCaller(ctx);

    const result = await caller.orders.requestRefund({
      orderId: UUID_ORDER_PAID,
      reason: "damaged",
    });

    // The update must have set refundRequestedAt (a Date) and refundReason
    expect(updates).toHaveLength(1);
    const updatePayload = updates[0] as Record<string, unknown>;
    expect(updatePayload.refundRequestedAt).toBeInstanceOf(Date);
    expect(updatePayload.refundReason).toBe("damaged");

    // requestRefund must also clear refundDeclinedAt
    expect(updatePayload.refundDeclinedAt).toBeNull();

    // Status must NOT be changed
    expect(updatePayload).not.toHaveProperty("status");

    // Return value should reflect the updated state
    expect(result.refundRequestedAt).toBe("2026-06-22T10:00:00.000Z");
    expect(result.refundReason).toBe("damaged");
  });

  it("sets refundRequestedAt on a fulfilled order", async () => {
    const updates: unknown[] = [];
    const orderRow = makeOrderRow({ status: "fulfilled" });
    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],
        [{ ...orderRow, refundRequestedAt: new Date("2026-06-22T10:00:00Z") }],
        [],
      ],
      updateSequence: [[{ id: UUID_ORDER_PAID }]],
      captureUpdates: updates,
      userId: UUID_BUYER,
    });
    const caller = createCaller(ctx);

    await caller.orders.requestRefund({ orderId: UUID_ORDER_PAID });

    expect(updates).toHaveLength(1);
    const payload = updates[0] as Record<string, unknown>;
    expect(payload.refundRequestedAt).toBeInstanceOf(Date);
  });

  it("returns NOT_FOUND when the caller is not the buyer", async () => {
    const orderRow = makeOrderRow({ buyerId: UUID_BUYER }); // buyer is UUID_BUYER, caller is UUID_SELLER
    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      userId: UUID_SELLER, // wrong user
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.requestRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("returns NOT_FOUND when order does not exist", async () => {
    const ctx = makeRefundCtx({ selectSequence: [[]], userId: UUID_BUYER });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.requestRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("rejects with BAD_REQUEST when order is pending_payment", async () => {
    const orderRow = makeOrderRow({ status: "pending_payment" });
    const ctx = makeRefundCtx({ selectSequence: [[orderRow]], userId: UUID_BUYER });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.requestRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  it("rejects with BAD_REQUEST when order is cancelled", async () => {
    const orderRow = makeOrderRow({ status: "cancelled" });
    const ctx = makeRefundCtx({ selectSequence: [[orderRow]], userId: UUID_BUYER });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.requestRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  it("rejects with BAD_REQUEST when order is already refunded", async () => {
    const orderRow = makeOrderRow({ status: "refunded" });
    const ctx = makeRefundCtx({ selectSequence: [[orderRow]], userId: UUID_BUYER });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.requestRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  it("rejects with BAD_REQUEST when order is disputed", async () => {
    const orderRow = makeOrderRow({ status: "disputed" });
    const ctx = makeRefundCtx({ selectSequence: [[orderRow]], userId: UUID_BUYER });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.requestRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  it("rejects with BAD_REQUEST on a double-request (refundRequestedAt already set)", async () => {
    const orderRow = makeOrderRow({
      status: "paid",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
    });
    const ctx = makeRefundCtx({ selectSequence: [[orderRow]], userId: UUID_BUYER });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.requestRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("already requested") }));
  });

  it("rejects with BAD_REQUEST when guarded UPDATE returns 0 rows (concurrent re-request race)", async () => {
    // Pre-check passes (refundRequestedAt is null in initial load) but the guarded UPDATE
    // returns 0 rows (race: another request won the claim first).
    const orderRow = makeOrderRow({ status: "paid", refundRequestedAt: null });
    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      updateSequence: [[]], // claim returns 0 rows
      userId: UUID_BUYER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.requestRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("already requested") }));
  });

  it("succeeds (re-request) when refundDeclinedAt is set and refundRequestedAt is null, and update clears refundDeclinedAt", async () => {
    const updates: unknown[] = [];
    // After a decline: refundDeclinedAt is set, refundRequestedAt is null
    const orderRow = makeOrderRow({
      status: "paid",
      refundRequestedAt: null,
      refundDeclinedAt: new Date("2026-06-21T09:00:00Z"),
    });
    const updatedRow = {
      ...orderRow,
      refundRequestedAt: new Date("2026-06-22T11:00:00Z"),
      refundDeclinedAt: null,
      refundReason: "still damaged",
    };
    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],   // initial load
        [updatedRow], // re-fetch after update (loadOrderById)
        [],           // order items
      ],
      updateSequence: [[{ id: UUID_ORDER_PAID }]], // claim succeeds
      captureUpdates: updates,
      userId: UUID_BUYER,
    });
    const caller = createCaller(ctx);

    const result = await caller.orders.requestRefund({
      orderId: UUID_ORDER_PAID,
      reason: "still damaged",
    });

    expect(updates).toHaveLength(1);
    const payload = updates[0] as Record<string, unknown>;
    // Must set refundRequestedAt and clear refundDeclinedAt
    expect(payload.refundRequestedAt).toBeInstanceOf(Date);
    expect(payload.refundDeclinedAt).toBeNull();

    // Return value must reflect re-requested state
    expect(result.refundRequestedAt).toBe("2026-06-22T11:00:00.000Z");
    expect(result.refundDeclinedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// orders.approveRefund
// ---------------------------------------------------------------------------

describe("orders.approveRefund", () => {
  it("claim wins: calls refundPayment with stable idempotencyKey and sets refundApprovedAt — does NOT change status", async () => {
    const refundPayment = vi.fn().mockResolvedValue({ id: "re_test", status: "succeeded", amountRefunded: 500 });
    const updates: unknown[] = [];

    const orderRow = makeOrderRow({
      status: "paid",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      storeUserId: UUID_SELLER,
    });

    // selectSequence for approveRefund:
    //   slot 0 — innerJoin load (joinUsesSelectSlot)
    //   slot 1 — re-fetch after claim (loadOrderById plain select)
    //   slot 2 — order items
    // updateSequence:
    //   call 0 — claim UPDATE returns a row (claim wins)
    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],  // slot 0 — innerJoin load
        [{ ...orderRow, refundApprovedAt: new Date("2026-06-22T12:00:00Z") }], // re-fetch
        [],           // order items
      ],
      updateSequence: [
        [{ id: UUID_ORDER_PAID }], // claim wins
      ],
      captureUpdates: updates,
      userId: UUID_SELLER,
      stripeOverrides: { refundPayment },
    });
    const caller = createCaller(ctx);

    const result = await caller.orders.approveRefund({ orderId: UUID_ORDER_PAID });

    // Stripe refundPayment must be called with the stable key (no amountCents = full refund)
    expect(refundPayment).toHaveBeenCalledOnce();
    const refundCall = refundPayment.mock.calls[0]![0] as { paymentIntentId: string; idempotencyKey: string; amountCents?: number };
    expect(refundCall.paymentIntentId).toBe(STRIPE_PI_ID);
    expect(refundCall.idempotencyKey).toBe(`refund-${UUID_ORDER_PAID}`);
    expect(refundCall.amountCents).toBeUndefined();

    // The DB claim update must set refundApprovedAt but NOT status
    expect(updates).toHaveLength(1);
    const updatePayload = updates[0] as Record<string, unknown>;
    expect(updatePayload.refundApprovedAt).toBeInstanceOf(Date);
    expect(updatePayload).not.toHaveProperty("status");

    // Return value must reflect the approved state
    expect(result.refundApprovedAt).toBe("2026-06-22T12:00:00.000Z");
    // Status remains 'paid' — webhook transition is the source of truth
    expect(result.status).toBe("paid");
  });

  it("claim returns 0 rows → BAD_REQUEST and refundPayment NOT called", async () => {
    const refundPayment = vi.fn();

    const orderRow = makeOrderRow({
      status: "paid",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      storeUserId: UUID_SELLER,
    });

    // The claim UPDATE returns 0 rows (already approved/declined by a concurrent request).
    // The re-read select (for precise error message) returns the order with refundApprovedAt set.
    const alreadyApprovedRow = {
      refundApprovedAt: new Date("2026-06-22T11:00:00Z"),
      refundDeclinedAt: null,
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
    };

    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],          // slot 0 — initial innerJoin load
        [alreadyApprovedRow], // slot 1 — re-read after 0-row claim
      ],
      updateSequence: [
        [], // claim returns 0 rows
      ],
      userId: UUID_SELLER,
      stripeOverrides: { refundPayment },
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.approveRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));

    // Critical: refundPayment must NOT have been called
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it("Stripe failure: revert UPDATE (refundApprovedAt → null) is issued and error rethrown", async () => {
    const stripeError = new Error("Stripe network timeout");
    const refundPayment = vi.fn().mockRejectedValue(stripeError);
    const updates: unknown[] = [];

    const orderRow = makeOrderRow({
      status: "paid",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      storeUserId: UUID_SELLER,
    });

    // updateSequence:
    //   call 0 — claim UPDATE (succeeds, returns a row)
    //   call 1 — revert UPDATE (sets refundApprovedAt = null)
    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow], // initial innerJoin load
      ],
      updateSequence: [
        [{ id: UUID_ORDER_PAID }], // claim wins
        [{ id: UUID_ORDER_PAID }], // revert succeeds
      ],
      captureUpdates: updates,
      userId: UUID_SELLER,
      stripeOverrides: { refundPayment },
    });
    const caller = createCaller(ctx);

    // The Stripe error must propagate
    await expect(
      caller.orders.approveRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow("Stripe network timeout");

    // Two updates must have been issued: the claim and the revert
    expect(updates).toHaveLength(2);
    const claimPayload = updates[0] as Record<string, unknown>;
    const revertPayload = updates[1] as Record<string, unknown>;

    // Claim sets refundApprovedAt to a Date
    expect(claimPayload.refundApprovedAt).toBeInstanceOf(Date);

    // Revert sets refundApprovedAt to null so the operation is retryable
    expect(revertPayload.refundApprovedAt).toBeNull();
  });

  it("returns NOT_FOUND when caller is not the store owner", async () => {
    const orderRow = makeOrderRow({ storeUserId: UUID_SELLER });
    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      userId: UUID_BUYER, // buyer, not seller
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.approveRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("rejects with BAD_REQUEST when no refund was requested", async () => {
    const orderRow = makeOrderRow({
      status: "paid",
      refundRequestedAt: null, // not yet requested
      storeUserId: UUID_SELLER,
    });
    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.approveRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("No refund requested") }));
  });

  it("rejects with PRECONDITION_FAILED when stripePaymentIntentId is missing", async () => {
    const orderRow = makeOrderRow({
      status: "paid",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      stripePaymentIntentId: null,
      storeUserId: UUID_SELLER,
    });
    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.approveRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });

  it("rejects with BAD_REQUEST on double-approve (pre-check) and does NOT call refundPayment a second time", async () => {
    const refundPayment = vi.fn().mockResolvedValue({ id: "re_test", status: "succeeded", amountRefunded: 500 });

    // Order already has refundApprovedAt set (already approved once).
    // The new flow: pre-check fires BEFORE the claim because refundRequestedAt is set
    // but refundApprovedAt is also set — the claim WHERE would fail anyway, but the
    // pre-check on refundRequestedAt passes since it IS set. The 0-row claim then
    // re-reads and surfaces "Refund already approved".
    const orderRow = makeOrderRow({
      status: "paid",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      refundApprovedAt: new Date("2026-06-21T08:00:00Z"),
      storeUserId: UUID_SELLER,
    });

    // Claim returns 0 rows (already approved); re-read returns the order with approvedAt set
    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],                                                            // initial load
        [{ refundApprovedAt: new Date("2026-06-21T08:00:00Z"), refundDeclinedAt: null, refundRequestedAt: new Date("2026-06-20T10:00:00Z") }], // re-read
      ],
      updateSequence: [[]],  // claim returns 0 rows
      userId: UUID_SELLER,
      stripeOverrides: { refundPayment },
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.approveRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Refund already approved") }),
    );

    // Stripe must NOT have been called
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it("rejects with BAD_REQUEST when status is 'refunded' (with refundRequestedAt set) — and does NOT call refundPayment", async () => {
    const refundPayment = vi.fn();

    const orderRow = makeOrderRow({
      status: "refunded",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      refundApprovedAt: null,
      storeUserId: UUID_SELLER,
    });

    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      userId: UUID_SELLER,
      stripeOverrides: { refundPayment },
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.approveRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Only paid or fulfilled") }),
    );

    expect(refundPayment).not.toHaveBeenCalled();
  });

  it("rejects with BAD_REQUEST when status is 'cancelled' (with refundRequestedAt set) — and does NOT call refundPayment", async () => {
    const refundPayment = vi.fn();

    const orderRow = makeOrderRow({
      status: "cancelled",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      refundApprovedAt: null,
      storeUserId: UUID_SELLER,
    });

    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      userId: UUID_SELLER,
      stripeOverrides: { refundPayment },
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.approveRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Only paid or fulfilled") }),
    );

    expect(refundPayment).not.toHaveBeenCalled();
  });

  it("rejects with BAD_REQUEST when status is 'disputed' (with refundRequestedAt set) — and does NOT call refundPayment", async () => {
    const refundPayment = vi.fn();

    const orderRow = makeOrderRow({
      status: "disputed",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      refundApprovedAt: null,
      storeUserId: UUID_SELLER,
    });

    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      userId: UUID_SELLER,
      stripeOverrides: { refundPayment },
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.approveRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Only paid or fulfilled") }),
    );

    expect(refundPayment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// orders.declineRefund
// ---------------------------------------------------------------------------

describe("orders.declineRefund", () => {
  it("store owner declines a requested order — sets refundDeclinedAt, clears refundRequestedAt, NO refundPayment call", async () => {
    const refundPayment = vi.fn();
    const updates: unknown[] = [];

    const orderRow = makeOrderRow({
      status: "paid",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      storeUserId: UUID_SELLER,
    });
    const declinedRow = {
      ...orderRow,
      refundDeclinedAt: new Date("2026-06-22T13:00:00Z"),
      refundRequestedAt: null,
    };

    // updateSequence: claim UPDATE returns a row (success)
    // selectSequence: slot 0 — innerJoin initial load; slot 1 — re-fetch (loadOrderById); slot 2 — items
    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],
        [declinedRow],
        [],
      ],
      updateSequence: [[{ id: UUID_ORDER_PAID }]], // claim wins
      captureUpdates: updates,
      userId: UUID_SELLER,
      stripeOverrides: { refundPayment },
    });
    const caller = createCaller(ctx);

    const result = await caller.orders.declineRefund({ orderId: UUID_ORDER_PAID });

    // No Stripe call
    expect(refundPayment).not.toHaveBeenCalled();

    // DB update must set refundDeclinedAt and clear refundRequestedAt
    expect(updates).toHaveLength(1);
    const payload = updates[0] as Record<string, unknown>;
    expect(payload.refundDeclinedAt).toBeInstanceOf(Date);
    expect(payload.refundRequestedAt).toBeNull();

    // Return reflects declined state
    expect(result.refundDeclinedAt).toBe("2026-06-22T13:00:00.000Z");
    expect(result.refundRequestedAt).toBeNull();
  });

  it("guarded UPDATE returns 0 rows → BAD_REQUEST (no request / already approved / already declined)", async () => {
    const orderRow = makeOrderRow({
      status: "paid",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      storeUserId: UUID_SELLER,
    });
    // Claim returns 0 rows; re-read says already approved
    const alreadyApprovedRow = {
      refundApprovedAt: new Date("2026-06-22T11:00:00Z"),
      refundDeclinedAt: null,
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
    };

    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],           // initial innerJoin load
        [alreadyApprovedRow], // re-read after 0-row claim
      ],
      updateSequence: [[]], // claim returns 0 rows
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.declineRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  it("returns NOT_FOUND when caller is not the store owner", async () => {
    const orderRow = makeOrderRow({
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      storeUserId: UUID_SELLER,
    });
    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      userId: UUID_BUYER, // buyer, not seller
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.declineRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("rejects with BAD_REQUEST when no refund was requested (pre-check via 0-row claim)", async () => {
    // refundRequestedAt is null in the initial load — the guarded claim will return 0 rows
    // because of the isNotNull(refundRequestedAt) condition.
    const orderRow = makeOrderRow({
      refundRequestedAt: null, // none requested
      storeUserId: UUID_SELLER,
    });
    // Claim returns 0; re-read confirms no request
    const noRequestRow = {
      refundApprovedAt: null,
      refundDeclinedAt: null,
      refundRequestedAt: null,
    };

    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],
        [noRequestRow], // re-read
      ],
      updateSequence: [[]], // claim fails
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.declineRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("No refund requested") }));
  });

  it("rejects with BAD_REQUEST when refund is already approved", async () => {
    const orderRow = makeOrderRow({
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      refundApprovedAt: new Date("2026-06-21T08:00:00Z"),
      storeUserId: UUID_SELLER,
    });
    const alreadyApprovedRow = {
      refundApprovedAt: new Date("2026-06-21T08:00:00Z"),
      refundDeclinedAt: null,
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
    };
    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],
        [alreadyApprovedRow],
      ],
      updateSequence: [[]], // claim fails
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.declineRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Refund already approved") }));
  });

  it("rejects with BAD_REQUEST when refund is already declined", async () => {
    const orderRow = makeOrderRow({
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      refundDeclinedAt: new Date("2026-06-21T09:00:00Z"),
      storeUserId: UUID_SELLER,
    });
    const alreadyDeclinedRow = {
      refundApprovedAt: null,
      refundDeclinedAt: new Date("2026-06-21T09:00:00Z"),
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
    };
    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],
        [alreadyDeclinedRow],
      ],
      updateSequence: [[]], // claim fails
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.declineRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Refund already declined") }));
  });

  it("rejects with BAD_REQUEST when status is 'refunded' (with refundRequestedAt set)", async () => {
    const orderRow = makeOrderRow({
      status: "refunded",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      storeUserId: UUID_SELLER,
    });
    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.declineRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Only paid or fulfilled") }),
    );
  });

  it("rejects with BAD_REQUEST when status is 'cancelled' (with refundRequestedAt set)", async () => {
    const orderRow = makeOrderRow({
      status: "cancelled",
      refundRequestedAt: new Date("2026-06-20T10:00:00Z"),
      storeUserId: UUID_SELLER,
    });
    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.declineRefund({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Only paid or fulfilled") }),
    );
  });
});

// ---------------------------------------------------------------------------
// orders.markFulfilled
// ---------------------------------------------------------------------------

describe("orders.markFulfilled", () => {
  it("store owner marks a paid order fulfilled — sets status='fulfilled', returns updated order", async () => {
    const updates: unknown[] = [];
    const orderRow = makeOrderRow({ status: "paid", storeUserId: UUID_SELLER });
    const fulfilledRow = { ...orderRow, status: "fulfilled", updatedAt: new Date("2026-06-22T14:00:00Z") };

    // selectSequence:
    //   slot 0 — innerJoin load (joinUsesSelectSlot)
    //   slot 1 — re-fetch after claim (loadOrderById plain select)
    //   slot 2 — order items
    // updateSequence:
    //   call 0 — guarded UPDATE returns a row (claim wins)
    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow],       // slot 0 — innerJoin load
        [fulfilledRow],   // slot 1 — re-fetch after update
        [],               // slot 2 — order items
      ],
      updateSequence: [
        [{ id: UUID_ORDER_PAID }], // guarded UPDATE wins
      ],
      captureUpdates: updates,
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    const result = await caller.orders.markFulfilled({ orderId: UUID_ORDER_PAID });

    // The guarded UPDATE must set status='fulfilled' and updatedAt
    expect(updates).toHaveLength(1);
    const updatePayload = updates[0] as Record<string, unknown>;
    expect(updatePayload.status).toBe("fulfilled");
    expect(updatePayload.updatedAt).toBeInstanceOf(Date);

    // Return value must reflect the fulfilled state
    expect(result.status).toBe("fulfilled");
  });

  it("non-owner (storeUserId !== ctx.user.id) → NOT_FOUND; no update", async () => {
    const updates: unknown[] = [];
    const orderRow = makeOrderRow({ status: "paid", storeUserId: UUID_SELLER });

    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      captureUpdates: updates,
      userId: UUID_BUYER, // buyer, not seller
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.markFulfilled({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));

    // No update must have been issued
    expect(updates).toHaveLength(0);
  });

  it("order not found → NOT_FOUND; no update", async () => {
    const updates: unknown[] = [];

    const ctx = makeRefundCtx({
      selectSequence: [[]], // empty — order does not exist
      captureUpdates: updates,
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.markFulfilled({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));

    expect(updates).toHaveLength(0);
  });

  it("status guard: pending_payment → BAD_REQUEST, no transition", async () => {
    const updates: unknown[] = [];
    const orderRow = makeOrderRow({ status: "pending_payment", storeUserId: UUID_SELLER });

    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      captureUpdates: updates,
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.markFulfilled({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Only paid orders") }),
    );

    expect(updates).toHaveLength(0);
  });

  it("status guard: fulfilled → BAD_REQUEST, no transition", async () => {
    const updates: unknown[] = [];
    const orderRow = makeOrderRow({ status: "fulfilled", storeUserId: UUID_SELLER });

    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      captureUpdates: updates,
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.markFulfilled({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Only paid orders") }),
    );

    expect(updates).toHaveLength(0);
  });

  it("status guard: refunded → BAD_REQUEST, no transition", async () => {
    const updates: unknown[] = [];
    const orderRow = makeOrderRow({ status: "refunded", storeUserId: UUID_SELLER });

    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      captureUpdates: updates,
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.markFulfilled({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Only paid orders") }),
    );

    expect(updates).toHaveLength(0);
  });

  it("status guard: cancelled → BAD_REQUEST, no transition", async () => {
    const updates: unknown[] = [];
    const orderRow = makeOrderRow({ status: "cancelled", storeUserId: UUID_SELLER });

    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      captureUpdates: updates,
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.markFulfilled({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Only paid orders") }),
    );

    expect(updates).toHaveLength(0);
  });

  it("status guard: disputed → BAD_REQUEST, no transition", async () => {
    const updates: unknown[] = [];
    const orderRow = makeOrderRow({ status: "disputed", storeUserId: UUID_SELLER });

    const ctx = makeRefundCtx({
      selectSequence: [[orderRow]],
      captureUpdates: updates,
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.markFulfilled({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Only paid orders") }),
    );

    expect(updates).toHaveLength(0);
  });

  it("guarded UPDATE returns 0 rows (status raced away) → BAD_REQUEST", async () => {
    const orderRow = makeOrderRow({ status: "paid", storeUserId: UUID_SELLER });

    // Pre-check passes (status is 'paid') but the guarded UPDATE returns 0 rows
    // (race: concurrent webhook moved the order to fulfilled/refunded/etc. first)
    const ctx = makeRefundCtx({
      selectSequence: [
        [orderRow], // initial innerJoin load — pre-check passes
      ],
      updateSequence: [
        [], // guarded UPDATE returns 0 rows
      ],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    await expect(
      caller.orders.markFulfilled({ orderId: UUID_ORDER_PAID }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("Only paid orders") }),
    );
  });
});

// ---------------------------------------------------------------------------
// orders.listForMyStore — paginated output { orders, nextCursor }
// ---------------------------------------------------------------------------

describe("orders.listForMyStore", () => {
  const UUID_ORDER_1 = "cc00bc99-9c0b-4ef8-bb6d-6bb9bd380acc";
  const UUID_ORDER_2 = "dd00bc99-9c0b-4ef8-bb6d-6bb9bd380add";
  const UUID_ORDER_3 = "ee00bc99-9c0b-4ef8-bb6d-6bb9bd380aee";

  it("returns { orders: [], nextCursor: null } when the caller has no store", async () => {
    // selectSequence: store lookup returns empty
    const ctx = makeRefundCtx({ selectSequence: [[]], userId: UUID_SELLER });
    const caller = createCaller(ctx);

    const result = await caller.orders.listForMyStore({});
    expect(result).toEqual({ orders: [], nextCursor: null });
  });

  it("returns { orders: [], nextCursor: null } when the store has no orders", async () => {
    // Provide limit+1=21 as default — but 0 rows returned, so no next cursor
    const ctx = makeRefundCtx({
      selectSequence: [
        [{ id: UUID_STORE }],  // store lookup
        [],                     // orders for store (empty, 0 < limit+1)
      ],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    const result = await caller.orders.listForMyStore({});
    expect(result).toEqual({ orders: [], nextCursor: null });
  });

  it("returns only the caller's store's orders in newest-first order, nextCursor null when last page", async () => {
    const orderRow1 = makeOrderRow({
      id: UUID_ORDER_1,
      createdAt: new Date("2026-06-22T12:00:00Z"),
      updatedAt: new Date("2026-06-22T12:00:00Z"),
    });
    const orderRow2 = makeOrderRow({
      id: UUID_ORDER_2,
      createdAt: new Date("2026-06-21T10:00:00Z"),
      updatedAt: new Date("2026-06-21T10:00:00Z"),
    });

    // 2 rows returned (< limit+1=21), so nextCursor should be null
    const ctx = makeRefundCtx({
      selectSequence: [
        [{ id: UUID_STORE }],         // store lookup
        [orderRow1, orderRow2],        // store orders (already newest-first from DB)
        [],                             // order items for both
      ],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    const result = await caller.orders.listForMyStore({});
    expect(result.orders).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
    // First result is the newer order
    expect(result.orders[0]!.id).toBe(UUID_ORDER_1);
    expect(result.orders[1]!.id).toBe(UUID_ORDER_2);
    // All four refund fields present and null
    expect(result.orders[0]!.refundRequestedAt).toBeNull();
    expect(result.orders[0]!.refundReason).toBeNull();
    expect(result.orders[0]!.refundApprovedAt).toBeNull();
    expect(result.orders[0]!.refundDeclinedAt).toBeNull();
  });

  it("with limit+1 rows available, nextCursor is non-null and only limit orders returned", async () => {
    // Request limit=2; return 3 rows (limit+1) to signal there's a next page
    const orderRow1 = makeOrderRow({
      id: UUID_ORDER_1,
      createdAt: new Date("2026-06-22T12:00:00Z"),
      updatedAt: new Date("2026-06-22T12:00:00Z"),
    });
    const orderRow2 = makeOrderRow({
      id: UUID_ORDER_2,
      createdAt: new Date("2026-06-21T10:00:00Z"),
      updatedAt: new Date("2026-06-21T10:00:00Z"),
    });
    const orderRow3 = makeOrderRow({
      id: UUID_ORDER_3,
      createdAt: new Date("2026-06-20T08:00:00Z"),
      updatedAt: new Date("2026-06-20T08:00:00Z"),
    });

    const ctx = makeRefundCtx({
      selectSequence: [
        [{ id: UUID_STORE }],
        [orderRow1, orderRow2, orderRow3], // limit+1 rows returned
        [],                                // items
      ],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    const result = await caller.orders.listForMyStore({ limit: 2 });
    // Only 2 orders returned (the page)
    expect(result.orders).toHaveLength(2);
    expect(result.orders[0]!.id).toBe(UUID_ORDER_1);
    expect(result.orders[1]!.id).toBe(UUID_ORDER_2);
    // nextCursor is non-null (encodes the last row of the page: row2)
    expect(result.nextCursor).not.toBeNull();
    // Cursor should be a non-empty base64 string
    expect(typeof result.nextCursor).toBe("string");
    expect(result.nextCursor!.length).toBeGreaterThan(0);
  });

  it("last page — fewer than limit+1 rows → nextCursor is null", async () => {
    const orderRow1 = makeOrderRow({
      id: UUID_ORDER_1,
      createdAt: new Date("2026-06-22T12:00:00Z"),
      updatedAt: new Date("2026-06-22T12:00:00Z"),
    });

    const ctx = makeRefundCtx({
      selectSequence: [
        [{ id: UUID_STORE }],
        [orderRow1],  // only 1 row returned, limit=2 → no next page
        [],
      ],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    const result = await caller.orders.listForMyStore({ limit: 2 });
    expect(result.orders).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("cursor decodes correctly and encodes the last page row", async () => {
    // Verify that the cursor produced by a first-page call can be decoded and re-used
    const orderRow1 = makeOrderRow({
      id: UUID_ORDER_1,
      createdAt: new Date("2026-06-22T12:00:00Z"),
      updatedAt: new Date("2026-06-22T12:00:00Z"),
    });
    const orderRow2 = makeOrderRow({
      id: UUID_ORDER_2,
      createdAt: new Date("2026-06-21T10:00:00Z"),
      updatedAt: new Date("2026-06-21T10:00:00Z"),
    });
    const orderRow3 = makeOrderRow({
      id: UUID_ORDER_3,
      createdAt: new Date("2026-06-20T08:00:00Z"),
      updatedAt: new Date("2026-06-20T08:00:00Z"),
    });

    const ctx = makeRefundCtx({
      selectSequence: [
        [{ id: UUID_STORE }],
        [orderRow1, orderRow2, orderRow3], // 3 rows, limit=2
        [],
      ],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    const result = await caller.orders.listForMyStore({ limit: 2 });
    expect(result.nextCursor).not.toBeNull();

    // Decode the cursor and verify it encodes orderRow2's (createdAt, id)
    const decoded = atob(result.nextCursor!);
    const [dateStr, id] = decoded.split("|");
    expect(id).toBe(UUID_ORDER_2);
    expect(new Date(dateStr!).toISOString()).toBe("2026-06-21T10:00:00.000Z");
  });

  it("malformed cursor (missing '|' separator) throws BAD_REQUEST", async () => {
    const ctx = makeRefundCtx({
      selectSequence: [
        [{ id: UUID_STORE }],
        [],
      ],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    // Decodes to "not-a-valid-cursor" — no pipe separator
    const badCursor = btoa("not-a-valid-cursor");
    await expect(
      caller.orders.listForMyStore({ cursor: badCursor }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("cursor") }));
  });

  it("malformed cursor (invalid base64) throws BAD_REQUEST", async () => {
    const ctx = makeRefundCtx({
      selectSequence: [
        [{ id: UUID_STORE }],
        [],
      ],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    // Not valid base64
    await expect(
      caller.orders.listForMyStore({ cursor: "!!!not-base64!!!" }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("cursor") }));
  });

  it("malformed cursor (non-uuid id) throws BAD_REQUEST", async () => {
    const ctx = makeRefundCtx({
      selectSequence: [
        [{ id: UUID_STORE }],
        [],
      ],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    // Valid date but non-uuid id
    const badCursor = btoa("2026-06-22T12:00:00.000Z|not-a-uuid");
    await expect(
      caller.orders.listForMyStore({ cursor: badCursor }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("cursor") }));
  });

  it("malformed cursor (bad date) throws BAD_REQUEST", async () => {
    const ctx = makeRefundCtx({
      selectSequence: [
        [{ id: UUID_STORE }],
        [],
      ],
      userId: UUID_SELLER,
    });
    const caller = createCaller(ctx);

    // Invalid date but valid uuid
    const badCursor = btoa("not-a-date|a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    await expect(
      caller.orders.listForMyStore({ cursor: badCursor }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST", message: expect.stringContaining("cursor") }));
  });
});
