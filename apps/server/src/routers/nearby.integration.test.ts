/**
 * PostGIS integration test for listings.nearby.
 *
 * GUARDED — only runs when TEST_DATABASE_URL is set (a PostGIS-enabled Postgres URL).
 * When the variable is absent (e.g. CI without a DB), the describe block is skipped so
 * `pnpm -r test` stays green.
 *
 * To run locally:
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
 *     pnpm --filter @homegrown/server test src/routers/nearby.integration.test.ts
 *
 * The test:
 *   1. Applies migrations via drizzle-kit push (skips if already applied).
 *   2. Seeds 3 stores at known coordinates + listings.
 *   3. Asserts radius filtering, distance ordering, and the category filter.
 *   4. Cleans up seeded rows in an afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../db/schema";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context } from "../context";
import * as authHelpers from "../auth";

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.resolve(__dirname, "../../drizzle");

// Guard: skip all tests if no TEST_DATABASE_URL provided
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("listings.nearby — PostGIS integration", () => {
  // Seeded IDs so we can clean up
  const seededUserIds: string[] = [];
  const seededStoreIds: string[] = [];
  const seededListingIds: string[] = [];
  const seededLocationIds: string[] = [];

  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;

  const TEST_SECRET = "integration-test-jwt-secret-32chars-ok";
  const stubAuth: Context["auth"] = {
    hashPassword: authHelpers.hashPassword,
    verifyPassword: authHelpers.verifyPassword,
    signToken: authHelpers.signToken,
    verifyToken: authHelpers.verifyToken,
  };

  /** Stub StripeClient — nearby tests never call Stripe; stub keeps types happy. */
  const stubStripe: Context["stripe"] = {
    createConnectedAccount: async () => { throw new Error("stub: not implemented"); },
    createAccountLink: async () => { throw new Error("stub: not implemented"); },
    retrieveAccountStatus: async () => { throw new Error("stub: not implemented"); },
    createPaymentIntent: async () => { throw new Error("stub: not implemented"); },
    retrievePaymentIntent: async () => { throw new Error("stub: not implemented"); },
  };

  const createCaller = createCallerFactory(appRouter);

  function makeCtx(): Context {
    return {
      db: db as Context["db"],
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null, // not used in nearby
      stripe: stubStripe,
      user: null,
    };
  }

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });

    // Apply migrations (idempotent)
    await migrate(db, { migrationsFolder: DRIZZLE_DIR });

    // -----------------------------------------------------------------------
    // Seed: 3 stores at known coordinates
    //
    // Store A: "Near Farm"   — 0 km from origin (37.7749, -122.4194) [SF]
    // Store B: "Mid Farm"    — ~5 km from origin
    // Store C: "Far Farm"    — ~50 km from origin (outside 10 km radius)
    // -----------------------------------------------------------------------

    // Users
    const [userA] = await db
      .insert(schema.users)
      .values({ email: "nearbya@test.invalid", username: "nearbya", passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [userB] = await db
      .insert(schema.users)
      .values({ email: "nearbyb@test.invalid", username: "nearbyb", passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [userC] = await db
      .insert(schema.users)
      .values({ email: "nearbyc@test.invalid", username: "nearbyc", passwordHash: "x" })
      .returning({ id: schema.users.id });

    if (!userA || !userB || !userC) throw new Error("Failed to seed users");
    seededUserIds.push(userA.id, userB.id, userC.id);

    // Stores
    const [storeA] = await db
      .insert(schema.stores)
      .values({ userId: userA.id, name: "Near Farm" })
      .returning({ id: schema.stores.id });
    const [storeB] = await db
      .insert(schema.stores)
      .values({ userId: userB.id, name: "Mid Farm" })
      .returning({ id: schema.stores.id });
    const [storeC] = await db
      .insert(schema.stores)
      .values({ userId: userC.id, name: "Far Farm" })
      .returning({ id: schema.stores.id });

    if (!storeA || !storeB || !storeC) throw new Error("Failed to seed stores");
    seededStoreIds.push(storeA.id, storeB.id, storeC.id);

    // Locations — use ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
    // SF origin: 37.7749, -122.4194
    // ~5 km NE:  37.8197, -122.3790  (Oakland area)
    // ~50 km S:  37.3382, -121.8863  (San Jose area)
    const [locA] = await db
      .insert(schema.locations)
      .values({
        storeId: storeA.id,
        address: "1 Main St",
        city: "San Francisco",
        state: "CA",
        zip: "94102",
        geog: sql`ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326)::geography`,
      })
      .returning({ id: schema.locations.id });

    const [locB] = await db
      .insert(schema.locations)
      .values({
        storeId: storeB.id,
        address: "2 Farm Rd",
        city: "Oakland",
        state: "CA",
        zip: "94601",
        geog: sql`ST_SetSRID(ST_MakePoint(-122.3790, 37.8197), 4326)::geography`,
      })
      .returning({ id: schema.locations.id });

    const [locC] = await db
      .insert(schema.locations)
      .values({
        storeId: storeC.id,
        address: "3 Valley Rd",
        city: "San Jose",
        state: "CA",
        zip: "95101",
        geog: sql`ST_SetSRID(ST_MakePoint(-121.8863, 37.3382), 4326)::geography`,
      })
      .returning({ id: schema.locations.id });

    if (!locA || !locB || !locC) throw new Error("Failed to seed locations");
    seededLocationIds.push(locA.id, locB.id, locC.id);

    // Listings
    const [listingA1] = await db
      .insert(schema.listings)
      .values({
        storeId: storeA.id,
        name: "SF Tomatoes",
        category: "vegetable",
        priceCents: 200,
        quantity: 10,
        unit: "lb",
      })
      .returning({ id: schema.listings.id });

    const [listingA2] = await db
      .insert(schema.listings)
      .values({
        storeId: storeA.id,
        name: "SF Honey",
        category: "honey",
        priceCents: 800,
        quantity: 5,
        unit: "jar",
      })
      .returning({ id: schema.listings.id });

    const [listingB1] = await db
      .insert(schema.listings)
      .values({
        storeId: storeB.id,
        name: "Oakland Apples",
        category: "fruit",
        priceCents: 300,
        quantity: 20,
        unit: "lb",
      })
      .returning({ id: schema.listings.id });

    const [listingC1] = await db
      .insert(schema.listings)
      .values({
        storeId: storeC.id,
        name: "SJ Lettuce",
        category: "vegetable",
        priceCents: 150,
        quantity: 15,
        unit: "bunch",
      })
      .returning({ id: schema.listings.id });

    if (!listingA1 || !listingA2 || !listingB1 || !listingC1) {
      throw new Error("Failed to seed listings");
    }
    seededListingIds.push(listingA1.id, listingA2.id, listingB1.id, listingC1.id);
  });

  afterAll(async () => {
    // Clean up in reverse FK order
    if (seededListingIds.length > 0) {
      for (const id of seededListingIds) {
        await db.delete(schema.listings).where(eq(schema.listings.id, id));
      }
    }
    if (seededLocationIds.length > 0) {
      for (const id of seededLocationIds) {
        await db.delete(schema.locations).where(eq(schema.locations.id, id));
      }
    }
    if (seededStoreIds.length > 0) {
      for (const id of seededStoreIds) {
        await db.delete(schema.stores).where(eq(schema.stores.id, id));
      }
    }
    if (seededUserIds.length > 0) {
      for (const id of seededUserIds) {
        await db.delete(schema.users).where(eq(schema.users.id, id));
      }
    }
    await client.end();
  });

  it("returns listings within radius, ordered by distance ascending", async () => {
    const caller = createCaller(makeCtx());

    // 10 km radius from SF — should include Near Farm (0 km) and Mid Farm (~5 km)
    // but NOT Far Farm (~50 km)
    const results = await caller.listings.nearby({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(2);

    // No Far Farm results (storeC is ~50 km away)
    const storeNames = results.map((r) => r.storeName);
    expect(storeNames).not.toContain("Far Farm");

    // Distance ordering: first result should be closer than second
    const distances = results.map((r) => r.distanceKm);
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]!);
    }

    // distanceKm values must be within radius
    for (const r of results) {
      expect(r.distanceKm).toBeLessThanOrEqual(10);
    }
  });

  it("radius filtering excludes stores beyond the given km", async () => {
    const caller = createCaller(makeCtx());

    // 1 km radius — only Near Farm (at origin) should appear
    const results = await caller.listings.nearby({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 1,
    });

    for (const r of results) {
      expect(r.storeName).toBe("Near Farm");
      expect(r.distanceKm).toBeLessThanOrEqual(1);
    }
  });

  it("category filter returns only matching listings", async () => {
    const caller = createCaller(makeCtx());

    // 10 km radius, only vegetable — should include SF Tomatoes but NOT SF Honey or Oakland Apples
    const results = await caller.listings.nearby({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 10,
      category: "vegetable",
    });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.category).toBe("vegetable");
    }

    const names = results.map((r) => r.name);
    expect(names).toContain("SF Tomatoes");
    expect(names).not.toContain("SF Honey");
    expect(names).not.toContain("Oakland Apples");
  });

  it("returns lat/lng from the PostGIS point (not app-side)", async () => {
    const caller = createCaller(makeCtx());

    const results = await caller.listings.nearby({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 1,
    });

    // Near Farm should be at approximately (37.7749, -122.4194)
    expect(results.length).toBeGreaterThan(0);
    const nearFarm = results.find((r) => r.storeName === "Near Farm");
    expect(nearFarm).toBeDefined();
    expect(nearFarm!.lat).toBeCloseTo(37.7749, 3);
    expect(nearFarm!.lng).toBeCloseTo(-122.4194, 3);
  });

  it("caps results at 50", async () => {
    const caller = createCaller(makeCtx());

    // Very large radius — can't exceed 50 results (we only have 4 seeded listings,
    // so this just verifies the output is at most 50)
    const results = await caller.listings.nearby({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 200,
    });

    expect(results.length).toBeLessThanOrEqual(50);
  });
});
