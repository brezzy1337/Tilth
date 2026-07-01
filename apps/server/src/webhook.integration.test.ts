/**
 * Postgres integration test for the manual-capture (F-026) webhook transitions.
 *
 * GUARDED — only runs when TEST_DATABASE_URL is set (same pattern as
 * routers/nearby.integration.test.ts). When absent (e.g. CI without a DB),
 * the describe block is skipped so `pnpm -r test` stays green.
 *
 * To run locally:
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
 *     pnpm --filter @homegrown/server test src/webhook.integration.test.ts
 *
 * Unlike webhook.test.ts (fake in-memory Db that doesn't enforce WHERE clauses),
 * this test hits a REAL Postgres row so the guarded UPDATE ... WHERE status = ...
 * clauses are actually exercised — this is the only way to prove, e.g., that
 * `payment_intent.canceled` really only flips 'pending_payment' OR 'paid' rows,
 * and leaves a 'fulfilled' order untouched.
 *
 * Covers:
 *   - payment_intent.amount_capturable_updated: pending_payment → paid.
 *   - payment_intent.succeeded: paid → fulfilled (capture, under manual capture).
 *   - payment_intent.canceled: cancels a 'paid' (authorized-but-uncaptured) order,
 *     not just a 'pending_payment' one.
 *   - payment_intent.canceled: does NOT touch an already-'fulfilled' order.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Stripe from "stripe";
import * as schema from "./db/schema";
import { handleStripeEvent } from "./webhook";
import type { Db, StripeClient } from "./context";

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.resolve(__dirname, "../drizzle");

// Guard: skip all tests if no TEST_DATABASE_URL provided
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("handleStripeEvent — manual-capture transitions (PostGIS/Postgres integration)", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;

  const seededUserIds: string[] = [];
  const seededStoreIds: string[] = [];
  const seededOrderIds: string[] = [];
  const seededEventIds: string[] = [];

  const stubStripeDep: Pick<StripeClient, "retrieveAccountStatus"> = {
    retrieveAccountStatus: async () => ({
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    }),
  };

  let eventCounter = 0;
  /**
   * Every call needs a globally-unique event.id — the `processed_stripe_events`
   * table persists across test runs (it is never truncated), so a fixed id like
   * "evt_test_1" would collide with a row left behind by a PRIOR run and be
   * silently treated as an already-processed duplicate (no-op). Mixing in
   * Date.now() + a per-run counter keeps ids unique across runs; ids are
   * cleaned up in afterAll for hygiene.
   */
  function nextEventId(): string {
    eventCounter += 1;
    const id = `evt_itest_${Date.now()}_${eventCounter}`;
    seededEventIds.push(id);
    return id;
  }

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: DRIZZLE_DIR });

    const [buyer] = await db
      .insert(schema.users)
      .values({
        email: `webhook-itest-buyer-${Date.now()}@example.com`,
        username: `webhook_itest_buyer_${Date.now()}`,
        passwordHash: "not-a-real-hash",
      })
      .returning({ id: schema.users.id });
    seededUserIds.push(buyer!.id);

    const [sellerUser] = await db
      .insert(schema.users)
      .values({
        email: `webhook-itest-seller-${Date.now()}@example.com`,
        username: `webhook_itest_seller_${Date.now()}`,
        passwordHash: "not-a-real-hash",
      })
      .returning({ id: schema.users.id });
    seededUserIds.push(sellerUser!.id);

    const [store] = await db
      .insert(schema.stores)
      .values({
        userId: sellerUser!.id,
        name: "Webhook Integration Test Farm",
        stripeConnectAccountId: `acct_itest_${Date.now()}`,
        chargesEnabled: true,
      })
      .returning({ id: schema.stores.id });
    seededStoreIds.push(store!.id);
  });

  afterAll(async () => {
    for (const eventId of seededEventIds) {
      await db
        .delete(schema.processedStripeEvents)
        .where(eq(schema.processedStripeEvents.id, eventId));
    }
    for (const orderId of seededOrderIds) {
      await db.delete(schema.orders).where(eq(schema.orders.id, orderId));
    }
    for (const storeId of seededStoreIds) {
      await db.delete(schema.stores).where(eq(schema.stores.id, storeId));
    }
    for (const userId of seededUserIds) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
    await client.end();
  });

  /** Insert a fresh order row in the given status with a unique PaymentIntent id. */
  async function seedOrder(status: "pending_payment" | "paid" | "fulfilled", piId: string) {
    const [order] = await db
      .insert(schema.orders)
      .values({
        storeId: seededStoreIds[0]!,
        buyerId: seededUserIds[0]!,
        status,
        subtotalCents: 1000,
        applicationFeeCents: 100,
        totalCents: 1000,
        stripePaymentIntentId: piId,
      })
      .returning({ id: schema.orders.id });
    seededOrderIds.push(order!.id);
    return order!.id;
  }

  async function readStatus(orderId: string): Promise<string> {
    const [row] = await db
      .select({ status: schema.orders.status })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId));
    return row!.status;
  }

  it("payment_intent.amount_capturable_updated: pending_payment → paid", async () => {
    const piId = `pi_itest_${Date.now()}_auth`;
    const orderId = await seedOrder("pending_payment", piId);

    const event = {
      id: nextEventId(),
      type: "payment_intent.amount_capturable_updated",
      data: { object: { id: piId } as Stripe.PaymentIntent },
    } as Stripe.Event;

    await handleStripeEvent(event, { db: db as unknown as Db, stripe: stubStripeDep });

    expect(await readStatus(orderId)).toBe("paid");
  });

  it("payment_intent.succeeded: paid → fulfilled (capture, not authorization)", async () => {
    const piId = `pi_itest_${Date.now()}_capture`;
    const orderId = await seedOrder("paid", piId);

    const event = {
      id: nextEventId(),
      type: "payment_intent.succeeded",
      data: { object: { id: piId } as Stripe.PaymentIntent },
    } as Stripe.Event;

    await handleStripeEvent(event, { db: db as unknown as Db, stripe: stubStripeDep });

    expect(await readStatus(orderId)).toBe("fulfilled");
  });

  it("payment_intent.canceled: cancels a 'paid' (authorized-but-uncaptured) order, not just 'pending_payment'", async () => {
    const piId = `pi_itest_${Date.now()}_void`;
    const orderId = await seedOrder("paid", piId);

    const event = {
      id: nextEventId(),
      type: "payment_intent.canceled",
      data: { object: { id: piId } as Stripe.PaymentIntent },
    } as Stripe.Event;

    await handleStripeEvent(event, { db: db as unknown as Db, stripe: stubStripeDep });

    expect(await readStatus(orderId)).toBe("cancelled");
  });

  it("payment_intent.canceled: still cancels a 'pending_payment' order (pre-existing behavior preserved)", async () => {
    const piId = `pi_itest_${Date.now()}_pending_cancel`;
    const orderId = await seedOrder("pending_payment", piId);

    const event = {
      id: nextEventId(),
      type: "payment_intent.canceled",
      data: { object: { id: piId } as Stripe.PaymentIntent },
    } as Stripe.Event;

    await handleStripeEvent(event, { db: db as unknown as Db, stripe: stubStripeDep });

    expect(await readStatus(orderId)).toBe("cancelled");
  });

  it("payment_intent.canceled: does NOT touch an already-'fulfilled' order (guard excludes captured orders)", async () => {
    const piId = `pi_itest_${Date.now()}_already_fulfilled`;
    const orderId = await seedOrder("fulfilled", piId);

    const event = {
      id: nextEventId(),
      type: "payment_intent.canceled",
      data: { object: { id: piId } as Stripe.PaymentIntent },
    } as Stripe.Event;

    await handleStripeEvent(event, { db: db as unknown as Db, stripe: stubStripeDep });

    // Status must remain 'fulfilled' — the WHERE guard only matches
    // pending_payment|paid, so a captured order is never accidentally cancelled.
    expect(await readStatus(orderId)).toBe("fulfilled");
  });
});
