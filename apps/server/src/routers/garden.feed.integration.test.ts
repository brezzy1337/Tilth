/**
 * PostGIS integration test for garden.feed.
 *
 * GUARDED — only runs when TEST_DATABASE_URL is set (mirrors
 * nearby.integration.test.ts). To run locally:
 *
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
 *     pnpm --filter @homegrown/server test src/routers/garden.feed.integration.test.ts
 *
 * The test:
 *   1. Applies migrations via migrateForTest (idempotent, advisory-lock-guarded).
 *   2. Seeds 3 stores at known coordinates (Near/Mid/Far, same layout as
 *      nearby.integration.test.ts) + garden_posts across photo_set/video types
 *      and processing/ready/errored statuses, with explicit created_at
 *      timestamps for deterministic ordering.
 *   3. Asserts: radius filtering, ready-only filtering, recency ordering
 *      (created_at DESC, id DESC), and keyset cursor pagination across 2 pages.
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

describeWithDb("garden.feed — PostGIS integration", () => {
  const seededUserIds: string[] = [];
  const seededStoreIds: string[] = [];
  const seededLocationIds: string[] = [];
  const seededPostIds: string[] = [];

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
      geocode: async () => null,
      stripe: stubStripe,
      media: null,
      mux: null,
      user: null,
    };
  }

  // Deterministic timestamps, oldest → newest.
  const T0 = new Date("2026-01-01T00:00:00.000Z");
  const T1 = new Date("2026-01-01T00:01:00.000Z");
  const T2 = new Date("2026-01-01T00:02:00.000Z");
  const T3 = new Date("2026-01-01T00:03:00.000Z");
  const T4 = new Date("2026-01-01T00:04:00.000Z");

  let storeAId: string, storeBId: string, storeCId: string;
  let postNearOld: string, postNearVideo: string, postNearProcessing: string, postNearErrored: string, postNearNew: string;
  let postMid: string, postFar: string;

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });

    await migrateForTest(client, db);

    // -------------------------------------------------------------------
    // Seed: 3 stores at known coordinates (same layout as nearby.integration.test.ts)
    // Store A: "Near Garden" — 0 km from origin (37.7749, -122.4194) [SF]
    // Store B: "Mid Garden"  — ~5 km from origin (Oakland)
    // Store C: "Far Garden"  — ~50 km from origin (San Jose) — outside 10 km radius
    // -------------------------------------------------------------------

    const [userA] = await db
      .insert(schema.users)
      .values({ email: "gardena@test.invalid", username: "gardena", passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [userB] = await db
      .insert(schema.users)
      .values({ email: "gardenb@test.invalid", username: "gardenb", passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [userC] = await db
      .insert(schema.users)
      .values({ email: "gardenc@test.invalid", username: "gardenc", passwordHash: "x" })
      .returning({ id: schema.users.id });
    if (!userA || !userB || !userC) throw new Error("Failed to seed users");
    seededUserIds.push(userA.id, userB.id, userC.id);

    const [storeA] = await db
      .insert(schema.stores)
      .values({ userId: userA.id, name: "Near Garden" })
      .returning({ id: schema.stores.id });
    const [storeB] = await db
      .insert(schema.stores)
      .values({ userId: userB.id, name: "Mid Garden" })
      .returning({ id: schema.stores.id });
    const [storeC] = await db
      .insert(schema.stores)
      .values({ userId: userC.id, name: "Far Garden" })
      .returning({ id: schema.stores.id });
    if (!storeA || !storeB || !storeC) throw new Error("Failed to seed stores");
    storeAId = storeA.id;
    storeBId = storeB.id;
    storeCId = storeC.id;
    seededStoreIds.push(storeAId, storeBId, storeCId);

    const [locA] = await db
      .insert(schema.locations)
      .values({
        storeId: storeAId,
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
        storeId: storeBId,
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
        storeId: storeCId,
        address: "3 Valley Rd",
        city: "San Jose",
        state: "CA",
        zip: "95101",
        geog: sql`ST_SetSRID(ST_MakePoint(-121.8863, 37.3382), 4326)::geography`,
      })
      .returning({ id: schema.locations.id });
    if (!locA || !locB || !locC) throw new Error("Failed to seed locations");
    seededLocationIds.push(locA.id, locB.id, locC.id);

    // -------------------------------------------------------------------
    // Seed garden_posts
    // -------------------------------------------------------------------

    const [pNearOld] = await db
      .insert(schema.gardenPosts)
      .values({
        storeId: storeAId,
        type: "photo_set",
        status: "ready",
        caption: "Near — oldest ready photo set",
        photos: [{ url: "https://storage.googleapis.com/bucket/a.jpg" }],
        createdAt: T0,
      })
      .returning({ id: schema.gardenPosts.id });

    const [pNearVideo] = await db
      .insert(schema.gardenPosts)
      .values({
        storeId: storeAId,
        type: "video",
        status: "ready",
        caption: "Near — ready video",
        muxAssetId: "asset_test_1",
        muxPlaybackId: "playback_test_1",
        durationS: 12.5,
        createdAt: T1,
      })
      .returning({ id: schema.gardenPosts.id });

    const [pNearProcessing] = await db
      .insert(schema.gardenPosts)
      .values({
        storeId: storeAId,
        type: "video",
        status: "processing",
        caption: "Near — still processing (must be excluded)",
        muxUploadId: "upload_test_1",
        createdAt: T2,
      })
      .returning({ id: schema.gardenPosts.id });

    const [pNearErrored] = await db
      .insert(schema.gardenPosts)
      .values({
        storeId: storeAId,
        type: "video",
        status: "errored",
        caption: "Near — errored (must be excluded)",
        createdAt: T2,
      })
      .returning({ id: schema.gardenPosts.id });

    const [pNearNew] = await db
      .insert(schema.gardenPosts)
      .values({
        storeId: storeAId,
        type: "photo_set",
        status: "ready",
        caption: "Near — newest ready photo set",
        photos: [{ url: "https://storage.googleapis.com/bucket/b.jpg" }],
        createdAt: T3,
      })
      .returning({ id: schema.gardenPosts.id });

    const [pMid] = await db
      .insert(schema.gardenPosts)
      .values({
        storeId: storeBId,
        type: "photo_set",
        status: "ready",
        caption: "Mid — ready photo set",
        photos: [{ url: "https://storage.googleapis.com/bucket/c.jpg" }],
        createdAt: T2,
      })
      .returning({ id: schema.gardenPosts.id });

    const [pFar] = await db
      .insert(schema.gardenPosts)
      .values({
        storeId: storeCId,
        type: "photo_set",
        status: "ready",
        caption: "Far — ready photo set (must be excluded by radius)",
        photos: [{ url: "https://storage.googleapis.com/bucket/d.jpg" }],
        createdAt: T4,
      })
      .returning({ id: schema.gardenPosts.id });

    if (
      !pNearOld || !pNearVideo || !pNearProcessing || !pNearErrored || !pNearNew || !pMid || !pFar
    ) {
      throw new Error("Failed to seed garden posts");
    }
    postNearOld = pNearOld.id;
    postNearVideo = pNearVideo.id;
    postNearProcessing = pNearProcessing.id;
    postNearErrored = pNearErrored.id;
    postNearNew = pNearNew.id;
    postMid = pMid.id;
    postFar = pFar.id;
    seededPostIds.push(
      postNearOld,
      postNearVideo,
      postNearProcessing,
      postNearErrored,
      postNearNew,
      postMid,
      postFar,
    );
  });

  afterAll(async () => {
    for (const id of seededPostIds) {
      await db.delete(schema.gardenPosts).where(eq(schema.gardenPosts.id, id));
    }
    for (const id of seededLocationIds) {
      await db.delete(schema.locations).where(eq(schema.locations.id, id));
    }
    for (const id of seededStoreIds) {
      await db.delete(schema.stores).where(eq(schema.stores.id, id));
    }
    for (const id of seededUserIds) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await client.end();
  });

  it("returns only status='ready' posts within radius (excludes processing/errored/out-of-radius)", async () => {
    const caller = createCaller(makeCtx());

    const result = await caller.garden.feed({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 10,
      limit: 50,
    });

    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(postNearOld);
    expect(ids).toContain(postNearVideo);
    expect(ids).toContain(postNearNew);
    expect(ids).toContain(postMid);

    // Excluded: processing, errored, and out-of-radius (Far Garden).
    expect(ids).not.toContain(postNearProcessing);
    expect(ids).not.toContain(postNearErrored);
    expect(ids).not.toContain(postFar);
  });

  it("orders results by created_at DESC, id DESC (recency feed)", async () => {
    const caller = createCaller(makeCtx());

    const result = await caller.garden.feed({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 10,
      limit: 50,
    });

    const createdAts = result.items.map((i) => new Date(i.createdAt).getTime());
    for (let i = 1; i < createdAts.length; i++) {
      expect(createdAts[i]).toBeLessThanOrEqual(createdAts[i - 1]!);
    }

    // The newest ready post (postNearNew, T3) must come first.
    expect(result.items[0]?.id).toBe(postNearNew);
  });

  it("radius filtering: a 1 km radius returns only Near Garden's posts", async () => {
    const caller = createCaller(makeCtx());

    const result = await caller.garden.feed({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 1,
      limit: 50,
    });

    for (const item of result.items) {
      expect(item.storeName).toBe("Near Garden");
    }
    const ids = result.items.map((i) => i.id);
    expect(ids).not.toContain(postMid);
    expect(ids).not.toContain(postFar);
  });

  it("distanceKm is computed via PostGIS and is within the requested radius", async () => {
    const caller = createCaller(makeCtx());

    const result = await caller.garden.feed({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 10,
      limit: 50,
    });

    for (const item of result.items) {
      expect(item.distanceKm).toBeLessThanOrEqual(10);
      expect(item.distanceKm).toBeGreaterThanOrEqual(0);
    }
  });

  it("maps a video post's type-specific fields (muxPlaybackId, posterUrl, durationS)", async () => {
    const caller = createCaller(makeCtx());

    const result = await caller.garden.feed({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 10,
      limit: 50,
    });

    const video = result.items.find((i) => i.id === postNearVideo);
    expect(video).toBeDefined();
    expect(video?.type).toBe("video");
    if (video?.type === "video") {
      expect(video.muxPlaybackId).toBe("playback_test_1");
      expect(video.posterUrl).toBe("https://image.mux.com/playback_test_1/thumbnail.png");
      expect(video.durationS).toBe(12.5);
    }
  });

  it("maps a photo-set post's type-specific fields (photos array)", async () => {
    const caller = createCaller(makeCtx());

    const result = await caller.garden.feed({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 10,
      limit: 50,
    });

    const photoSet = result.items.find((i) => i.id === postNearNew);
    expect(photoSet).toBeDefined();
    expect(photoSet?.type).toBe("photo_set");
    if (photoSet?.type === "photo_set") {
      expect(photoSet.photos).toEqual([{ url: "https://storage.googleapis.com/bucket/b.jpg" }]);
    }
  });

  it("keyset cursor pagination: two pages of limit=2 cover all 4 ready+in-radius posts with no overlap", async () => {
    const caller = createCaller(makeCtx());

    // 4 ready posts within 10 km: postNearNew(T3), postMid(T2), postNearVideo(T1), postNearOld(T0).
    // (postNearProcessing/postNearErrored share T2 but are excluded by status.)
    const page1 = await caller.garden.feed({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 10,
      limit: 2,
    });

    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.items.map((i) => i.id)).toEqual([postNearNew, postMid]);

    const page2 = await caller.garden.feed({
      lat: 37.7749,
      lng: -122.4194,
      radiusKm: 10,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });

    expect(page2.items).toHaveLength(2);
    expect(page2.items.map((i) => i.id)).toEqual([postNearVideo, postNearOld]);
    // Exactly 4 matching posts total — the second page is the last one.
    expect(page2.nextCursor).toBeNull();

    // No overlap between pages.
    const page1Ids = new Set(page1.items.map((i) => i.id));
    for (const item of page2.items) {
      expect(page1Ids.has(item.id)).toBe(false);
    }
  });

  it("throws BAD_REQUEST on a malformed cursor", async () => {
    const caller = createCaller(makeCtx());

    await expect(
      caller.garden.feed({
        lat: 37.7749,
        lng: -122.4194,
        radiusKm: 10,
        cursor: "not-a-valid-cursor!!",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });
});
