/**
 * PostGIS integration test for places.nearby (F-048).
 *
 * GUARDED — only runs when TEST_DATABASE_URL is set (mirrors
 * nearby.integration.test.ts / chat.integration.test.ts). To run locally:
 *
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
 *     pnpm --filter @homegrown/server test src/routers/places.nearby.integration.test.ts
 *
 * The test:
 *   1. Applies migrations via migrateForTest (skips if already applied).
 *   2. Seeds approved + pending community_places at known coordinates.
 *   3. Asserts radius filtering, distance ordering, the type filter, and
 *      that pending (unreviewed) rows are excluded from results.
 *   4. Cleans up seeded rows in an afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import { migrateForTest } from "../db/migrate-for-test";
import * as schema from "../db/schema";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context } from "../context";
import * as authHelpers from "../auth";

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];

const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("places.nearby — PostGIS integration", () => {
  const seededPlaceIds: string[] = [];

  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;

  const TEST_SECRET = "integration-test-jwt-secret-32chars-ok";
  const stubAuth: Context["auth"] = {
    hashPassword: authHelpers.hashPassword,
    verifyPassword: authHelpers.verifyPassword,
    signToken: authHelpers.signToken,
    verifyToken: authHelpers.verifyToken,
  };

  const stubStripe: Context["stripe"] = {
    createConnectedAccount: async () => {
      throw new Error("stub: not implemented");
    },
    createAccountLink: async () => {
      throw new Error("stub: not implemented");
    },
    retrieveAccountStatus: async () => {
      throw new Error("stub: not implemented");
    },
    createPaymentIntent: async () => {
      throw new Error("stub: not implemented");
    },
    retrievePaymentIntent: async () => {
      throw new Error("stub: not implemented");
    },
    cancelPaymentIntent: async () => {
      throw new Error("stub: not implemented");
    },
    capturePaymentIntent: async () => {
      throw new Error("stub: not implemented");
    },
    refundPayment: async () => {
      throw new Error("stub: not implemented");
    },
    createDashboardLink: async () => {
      throw new Error("stub: not implemented");
    },
  };

  const createCaller = createCallerFactory(appRouter);

  function makeCtx(): Context {
    return {
      db: db as Context["db"],
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null, // not used in places.nearby
      stripe: stubStripe,
      media: null,
      mux: null,
      push: { send: async () => {} },
      user: null,
    };
  }

  /** Small helper: insert a community_places row at a known point. */
  async function seedPlace(place: {
    type: string;
    name: string;
    lat: number;
    lng: number;
    status: string;
    source?: string;
    sourceRef: string;
  }): Promise<string> {
    const [row] = await db
      .insert(schema.communityPlaces)
      .values({
        type: place.type,
        name: place.name,
        location: sql`ST_SetSRID(ST_MakePoint(${place.lng}, ${place.lat}), 4326)::geography`,
        status: place.status,
        source: place.source ?? "osm",
        sourceRef: place.sourceRef,
      })
      .returning({ id: schema.communityPlaces.id });
    if (!row) throw new Error(`Failed to seed place "${place.name}"`);
    return row.id;
  }

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });

    await migrateForTest(client, db);

    // -----------------------------------------------------------------------
    // Seed around SF origin (37.7749, -122.4194):
    //   Near Co-op        — approved, ~0 km, type=coop
    //   Mid Health Food    — approved, ~5 km, type=health_food
    //   Far Farmers Market — approved, ~50 km (outside 10 km radius), type=farmers_market
    //   Pending Market      — PENDING (unreviewed), ~0.1 km — must never be served
    // -----------------------------------------------------------------------
    seededPlaceIds.push(
      await seedPlace({
        type: "coop",
        name: "Near Co-op",
        lat: 37.7749,
        lng: -122.4194,
        status: "approved",
        sourceRef: "osm:node/1001",
      }),
    );
    seededPlaceIds.push(
      await seedPlace({
        type: "health_food",
        name: "Mid Health Food",
        lat: 37.8197,
        lng: -122.379,
        status: "approved",
        sourceRef: "osm:node/1002",
      }),
    );
    seededPlaceIds.push(
      await seedPlace({
        type: "farmers_market",
        name: "Far Farmers Market",
        lat: 37.3382,
        lng: -121.8863,
        status: "approved",
        sourceRef: "osm:way/1003",
      }),
    );
    seededPlaceIds.push(
      await seedPlace({
        type: "farmers_market",
        name: "Pending Market",
        lat: 37.7751,
        lng: -122.4192,
        status: "pending",
        sourceRef: "usda:9999",
      }),
    );
  });

  afterAll(async () => {
    for (const id of seededPlaceIds) {
      await db.delete(schema.communityPlaces).where(eq(schema.communityPlaces.id, id));
    }
    await client.end();
  });

  it("returns approved places within radius, ordered by distance ascending", async () => {
    const caller = createCaller(makeCtx());

    const results = await caller.places.nearby({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 10,
    });

    const names = results.map((r) => r.name);
    expect(names).toContain("Near Co-op");
    expect(names).toContain("Mid Health Food");
    expect(names).not.toContain("Far Farmers Market");

    const distances = results.map((r) => r.distanceKm);
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]!);
    }
    for (const r of results) {
      expect(r.distanceKm).toBeLessThanOrEqual(10);
    }
  });

  it("excludes pending (unreviewed) rows even when within radius", async () => {
    const caller = createCaller(makeCtx());

    const results = await caller.places.nearby({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 1,
    });

    const names = results.map((r) => r.name);
    expect(names).not.toContain("Pending Market");
    expect(names).toContain("Near Co-op");
  });

  it("radius filtering excludes places beyond the given km", async () => {
    const caller = createCaller(makeCtx());

    const results = await caller.places.nearby({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 1,
    });

    for (const r of results) {
      expect(r.name).not.toBe("Far Farmers Market");
      expect(r.distanceKm).toBeLessThanOrEqual(1);
    }
  });

  it("type filter returns only matching places", async () => {
    const caller = createCaller(makeCtx());

    const results = await caller.places.nearby({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 10,
      type: "health_food",
    });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.type).toBe("health_food");
    }
    const names = results.map((r) => r.name);
    expect(names).toContain("Mid Health Food");
    expect(names).not.toContain("Near Co-op");
  });

  it("returns lat/lng from the PostGIS point (not app-side)", async () => {
    const caller = createCaller(makeCtx());

    const results = await caller.places.nearby({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 1,
    });

    const nearCoop = results.find((r) => r.name === "Near Co-op");
    expect(nearCoop).toBeDefined();
    expect(nearCoop!.lat).toBeCloseTo(37.7749, 3);
    expect(nearCoop!.lng).toBeCloseTo(-122.4194, 3);
  });

  it("caps results at 200", async () => {
    const caller = createCaller(makeCtx());

    const results = await caller.places.nearby({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 100,
    });

    expect(results.length).toBeLessThanOrEqual(200);
  });
});
