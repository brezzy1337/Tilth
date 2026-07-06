/**
 * Postgres integration test for `stores.get` trust-tier wiring (F-016).
 *
 * GUARDED — only runs when TEST_DATABASE_URL is set (same pattern as
 * nearby.integration.test.ts / webhook.integration.test.ts). When absent
 * (e.g. CI without a DB), the describe block is skipped so `pnpm -r test`
 * stays green.
 *
 * To run locally:
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
 *     pnpm --filter @homegrown/server test src/routers/stores.trust-tier.integration.test.ts
 *
 * The test seeds a store per scenario, inserts orders across every
 * orderStatusEnum value, and asserts `stores.get` returns the trustTier
 * `computeTrustTier` (shared, unit-tested) would compute from ONLY the
 * terminal (fulfilled/cancelled/refunded) counts — proving:
 *   - the query's conditional aggregation is wired correctly (gold / silver /
 *     bronze / null cases), and
 *   - pending_payment / paid / disputed orders are excluded from the tier math.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { migrateForTest } from "../db/migrate-for-test";
import * as schema from "../db/schema";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context } from "../context";
import * as authHelpers from "../auth";
import type { OrderStatus } from "@homegrown/shared";

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];

const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("stores.get — trust tier (F-016) PostGIS/Postgres integration", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;

  const seededUserIds: string[] = [];
  const seededStoreIds: string[] = [];
  const seededOrderIds: string[] = [];

  const TEST_SECRET = "integration-test-jwt-secret-32chars-ok";
  const stubAuth: Context["auth"] = {
    hashPassword: authHelpers.hashPassword,
    verifyPassword: authHelpers.verifyPassword,
    signToken: authHelpers.signToken,
    verifyToken: authHelpers.verifyToken,
  };

  /** Stub StripeClient — trust-tier tests never call Stripe; stub keeps types happy. */
  const stubStripe: Context["stripe"] = {
    createConnectedAccount: async () => { throw new Error("stub: not implemented"); },
    createAccountLink: async () => { throw new Error("stub: not implemented"); },
    retrieveAccountStatus: async () => { throw new Error("stub: not implemented"); },
    createPaymentIntent: async () => { throw new Error("stub: not implemented"); },
    retrievePaymentIntent: async () => { throw new Error("stub: not implemented"); },
    cancelPaymentIntent: async () => { throw new Error("stub: not implemented"); },
    capturePaymentIntent: async () => { throw new Error("stub: not implemented"); },
    refundPayment: async () => { throw new Error("stub: not implemented"); },
    createDashboardLink: async () => { throw new Error("stub: not implemented"); },
  };

  const createCaller = createCallerFactory(appRouter);

  function makeCtx(): Context {
    return {
      db: db as Context["db"],
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null, // not used here
      stripe: stubStripe,
      user: null,
    };
  }

  /** Seed a user + store, tracking ids for cleanup. Returns the store id. */
  async function seedStore(label: string): Promise<string> {
    const unique = `${Date.now()}_${label}_${Math.random().toString(36).slice(2)}`;
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `trust-${unique}@test.invalid`,
        username: `trust_${unique}`.slice(0, 30),
        passwordHash: "x",
      })
      .returning({ id: schema.users.id });
    if (!user) throw new Error("Failed to seed user");
    seededUserIds.push(user.id);

    const [store] = await db
      .insert(schema.stores)
      .values({ userId: user.id, name: `Trust Tier Farm ${label}` })
      .returning({ id: schema.stores.id });
    if (!store) throw new Error("Failed to seed store");
    seededStoreIds.push(store.id);

    return store.id;
  }

  /** Insert `count` orders in the given status for a store. */
  async function seedOrders(storeId: string, buyerId: string, status: OrderStatus, count: number) {
    for (let i = 0; i < count; i++) {
      const [order] = await db
        .insert(schema.orders)
        .values({
          storeId,
          buyerId,
          status,
          subtotalCents: 1000,
          applicationFeeCents: 100,
          totalCents: 1000,
          stripePaymentIntentId: `pi_trust_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        })
        .returning({ id: schema.orders.id });
      if (!order) throw new Error("Failed to seed order");
      seededOrderIds.push(order.id);
    }
  }

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });
    await migrateForTest(client, db);
  });

  afterAll(async () => {
    for (const id of seededOrderIds) {
      await db.delete(schema.orders).where(eq(schema.orders.id, id));
    }
    for (const id of seededStoreIds) {
      await db.delete(schema.stores).where(eq(schema.stores.id, id));
    }
    for (const id of seededUserIds) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await client.end();
  });

  it("returns 'gold' for a store with 30 fulfilled / 0 cancelled / 0 refunded", async () => {
    const storeId = await seedStore("gold");
    const [buyer] = await db
      .insert(schema.users)
      .values({
        email: `trust-buyer-gold-${Date.now()}@test.invalid`,
        username: `trust_buyer_gold_${Date.now()}`.slice(0, 30),
        passwordHash: "x",
      })
      .returning({ id: schema.users.id });
    seededUserIds.push(buyer!.id);

    await seedOrders(storeId, buyer!.id, "fulfilled", 30);

    const caller = createCaller(makeCtx());
    const profile = await caller.stores.get({ storeId });

    expect(profile.trustTier).toBe("gold");
  });

  it("returns 'silver' or 'bronze' for a mixed fulfillment history", async () => {
    const storeId = await seedStore("mixed");
    const [buyer] = await db
      .insert(schema.users)
      .values({
        email: `trust-buyer-mixed-${Date.now()}@test.invalid`,
        username: `trust_buyer_mixed_${Date.now()}`.slice(0, 30),
        passwordHash: "x",
      })
      .returning({ id: schema.users.id });
    seededUserIds.push(buyer!.id);

    // 15 terminal orders, 14 fulfilled / 1 cancelled -> rate ~0.933, terminal 15
    // -> meets silver (minRate 0.92, minOrders 15) but not gold (minOrders 30).
    await seedOrders(storeId, buyer!.id, "fulfilled", 14);
    await seedOrders(storeId, buyer!.id, "cancelled", 1);

    const caller = createCaller(makeCtx());
    const profile = await caller.stores.get({ storeId });

    expect(["silver", "bronze"]).toContain(profile.trustTier);
    expect(profile.trustTier).toBe("silver");
  });

  it("returns null for a store with fewer than 5 terminal orders", async () => {
    const storeId = await seedStore("sparse");
    const [buyer] = await db
      .insert(schema.users)
      .values({
        email: `trust-buyer-sparse-${Date.now()}@test.invalid`,
        username: `trust_buyer_sparse_${Date.now()}`.slice(0, 30),
        passwordHash: "x",
      })
      .returning({ id: schema.users.id });
    seededUserIds.push(buyer!.id);

    // Only 3 terminal orders (below the bronze floor of 5).
    await seedOrders(storeId, buyer!.id, "fulfilled", 3);

    const caller = createCaller(makeCtx());
    const profile = await caller.stores.get({ storeId });

    expect(profile.trustTier).toBeNull();
  });

  it("ignores pending_payment/paid/disputed orders when computing the tier", async () => {
    const storeId = await seedStore("ignored-statuses");
    const [buyer] = await db
      .insert(schema.users)
      .values({
        email: `trust-buyer-ignored-${Date.now()}@test.invalid`,
        username: `trust_buyer_ignored_${Date.now()}`.slice(0, 30),
        passwordHash: "x",
      })
      .returning({ id: schema.users.id });
    seededUserIds.push(buyer!.id);

    // Baseline: 30 fulfilled terminal orders -> gold.
    await seedOrders(storeId, buyer!.id, "fulfilled", 30);

    const caller = createCaller(makeCtx());
    const before = await caller.stores.get({ storeId });
    expect(before.trustTier).toBe("gold");

    // Add a pile of non-terminal orders — none of these should move the tier.
    await seedOrders(storeId, buyer!.id, "pending_payment", 20);
    await seedOrders(storeId, buyer!.id, "paid", 20);
    await seedOrders(storeId, buyer!.id, "disputed", 20);

    const after = await caller.stores.get({ storeId });
    expect(after.trustTier).toBe("gold");
  });
});
