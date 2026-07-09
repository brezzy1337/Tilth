/**
 * Postgres integration test for the `sourcing` router (F-049) + the F-049
 * surgical edits to `chat.messages`/`places.nearby`/`places.mine`.
 *
 * GUARDED — only runs when TEST_DATABASE_URL is set (mirrors
 * chat.integration.test.ts / places.nearby.integration.test.ts). To run locally:
 *
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
 *     pnpm --filter @homegrown/server test src/routers/sourcing.integration.test.ts
 *
 * Fixtures (see beforeAll):
 *   placeUser   — linked buyer of `coopPlace` (approved).
 *   growerUser  — owns `growerStore` (near coopPlace, 4 listings).
 *   grower2User — owns `growerStore2` (farther away, 0 listings).
 *   strangerUser— no store, no linked place (authz-negative cases).
 *   unlinkedPlace — approved, no linked user (createOffer NOT_FOUND case).
 *   pendingPlace  — pending status (createOffer NOT_FOUND case).
 *
 * Covers:
 *   - createRequest: happy path (conversation created, message carries
 *     sourcingRequestId + summary body, DTO shape); NOT_FOUND for a
 *     non-linked caller; BAD_REQUEST targeting the caller's own store;
 *     FORBIDDEN for a blocked pair (generic message, mirrors chat.start).
 *   - createOffer: happy path (rides the SAME conversation as createRequest,
 *     since both resolve to (buyer=placeUser, store=growerStore)); NOT_FOUND
 *     for an unlinked place and for a pending place; FORBIDDEN for a blocked
 *     pair.
 *   - respond: counterparty flips status + appends a plain follow-up
 *     message; creator gets NOT_FOUND; responding to a non-pending request
 *     gets BAD_REQUEST.
 *   - withdraw: creator-only, pending-only (same NOT_FOUND/BAD_REQUEST shape).
 *   - listMine: returns rows for both the place-buyer role and the
 *     store-owner role.
 *   - growers: distance ordering, listingCount + sampleListings aggregation
 *     (including a zero-listing store), NOT_FOUND for a non-linked caller.
 *   - chat.messages: the originating message of each request/offer carries
 *     the request DTO; follow-up messages carry `sourcingRequest: null`.
 *   - places.nearby: `acceptsOffers` true for a linked place, false for an
 *     unlinked one.
 *   - places.mine: the linked place for a linked caller, null otherwise.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, sql } from "drizzle-orm";
import { migrateForTest } from "../db/migrate-for-test";
import * as schema from "../db/schema";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context, PushClient } from "../context";
import * as authHelpers from "../auth";

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("sourcing router — Postgres integration", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;

  const seededUserIds: string[] = [];
  const seededStoreIds: string[] = [];
  const seededPlaceIds: string[] = [];
  const seededConversationIds: string[] = [];

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

  const pushCalls: Array<{ tokens: string[]; title: string; body: string; data?: Record<string, unknown> }> = [];
  const capturingPush: PushClient = {
    async send(input) {
      pushCalls.push(input);
    },
  };

  function ctxFor(userId: string | null): Context {
    return {
      db: db as Context["db"],
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      media: null,
      mux: null,
      push: capturingPush,
      user: userId ? { id: userId } : null,
    };
  }

  // Coordinates: coop at SF origin; growerStore ~0km away; growerStore2 ~5km away.
  const COOP_LAT = 37.7749;
  const COOP_LNG = -122.4194;
  const GROWER2_LAT = 37.8197;
  const GROWER2_LNG = -122.379;

  let placeUserId: string;
  let growerUserId: string, growerStoreId: string, growerStoreName: string;
  let grower2UserId: string, growerStore2Id: string;
  let strangerUserId: string;
  let coopPlaceId: string, coopPlaceName: string;
  let unlinkedPlaceId: string;
  let pendingPlaceId: string;
  let selfOwnedStoreId: string;

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });
    await migrateForTest(client, db);

    const [placeUser] = await db
      .insert(schema.users)
      .values({ email: "sourcing-place@test.invalid", username: "sourcingplace", passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [growerUser] = await db
      .insert(schema.users)
      .values({ email: "sourcing-grower@test.invalid", username: "sourcinggrower", passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [grower2User] = await db
      .insert(schema.users)
      .values({ email: "sourcing-grower2@test.invalid", username: "sourcinggrower2", passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [strangerUser] = await db
      .insert(schema.users)
      .values({ email: "sourcing-stranger@test.invalid", username: "sourcingstranger", passwordHash: "x" })
      .returning({ id: schema.users.id });
    if (!placeUser || !growerUser || !grower2User || !strangerUser) throw new Error("Failed to seed users");

    placeUserId = placeUser.id;
    growerUserId = growerUser.id;
    grower2UserId = grower2User.id;
    strangerUserId = strangerUser.id;
    seededUserIds.push(placeUserId, growerUserId, grower2UserId, strangerUserId);

    const [growerStore] = await db
      .insert(schema.stores)
      .values({ userId: growerUserId, name: "Sourcing Grower Farm" })
      .returning({ id: schema.stores.id, name: schema.stores.name });
    const [growerStore2] = await db
      .insert(schema.stores)
      .values({ userId: grower2UserId, name: "Sourcing Far Farm" })
      .returning({ id: schema.stores.id });
    const [selfOwnedStore] = await db
      .insert(schema.stores)
      .values({ userId: placeUserId, name: "Sourcing Self-Owned Store" })
      .returning({ id: schema.stores.id });
    if (!growerStore || !growerStore2 || !selfOwnedStore) throw new Error("Failed to seed stores");

    growerStoreId = growerStore.id;
    growerStoreName = growerStore.name;
    growerStore2Id = growerStore2.id;
    selfOwnedStoreId = selfOwnedStore.id;
    seededStoreIds.push(growerStoreId, growerStore2Id, selfOwnedStoreId);

    await db.insert(schema.locations).values({
      storeId: growerStoreId,
      address: "1 Grower Way",
      city: "San Francisco",
      state: "CA",
      zip: "94103",
      geog: sql`ST_SetSRID(ST_MakePoint(${COOP_LNG}, ${COOP_LAT}), 4326)::geography`,
    });
    await db.insert(schema.locations).values({
      storeId: growerStore2Id,
      address: "2 Far Way",
      city: "San Francisco",
      state: "CA",
      zip: "94109",
      geog: sql`ST_SetSRID(ST_MakePoint(${GROWER2_LNG}, ${GROWER2_LAT}), 4326)::geography`,
    });

    // 4 listings for growerStore (staggered createdAt so sample ordering is deterministic);
    // growerStore2 intentionally has ZERO listings (must still appear in `growers`).
    const listingNames = ["Tomatoes", "Basil", "Eggs", "Honey"];
    for (let i = 0; i < listingNames.length; i++) {
      await db.insert(schema.listings).values({
        storeId: growerStoreId,
        name: listingNames[i]!,
        category: "vegetable",
        priceCents: 100,
        quantity: 10,
        unit: "lb",
        createdAt: new Date(Date.now() + i * 1000),
      });
    }

    const [coopPlace] = await db
      .insert(schema.communityPlaces)
      .values({
        type: "coop",
        name: "Sourcing Test Co-op",
        location: sql`ST_SetSRID(ST_MakePoint(${COOP_LNG}, ${COOP_LAT}), 4326)::geography`,
        status: "approved",
        source: "manual",
        sourceRef: "sourcing-test:coop",
        linkedUserId: placeUserId,
      })
      .returning({ id: schema.communityPlaces.id, name: schema.communityPlaces.name });
    const [unlinkedPlace] = await db
      .insert(schema.communityPlaces)
      .values({
        type: "coop",
        name: "Sourcing Unlinked Co-op",
        location: sql`ST_SetSRID(ST_MakePoint(${COOP_LNG}, ${COOP_LAT}), 4326)::geography`,
        status: "approved",
        source: "manual",
        sourceRef: "sourcing-test:unlinked",
      })
      .returning({ id: schema.communityPlaces.id });
    const [pendingPlace] = await db
      .insert(schema.communityPlaces)
      .values({
        type: "coop",
        name: "Sourcing Pending Co-op",
        location: sql`ST_SetSRID(ST_MakePoint(${COOP_LNG}, ${COOP_LAT}), 4326)::geography`,
        status: "pending",
        source: "manual",
        sourceRef: "sourcing-test:pending",
      })
      .returning({ id: schema.communityPlaces.id });
    if (!coopPlace || !unlinkedPlace || !pendingPlace) throw new Error("Failed to seed places");

    coopPlaceId = coopPlace.id;
    coopPlaceName = coopPlace.name;
    unlinkedPlaceId = unlinkedPlace.id;
    pendingPlaceId = pendingPlace.id;
    seededPlaceIds.push(coopPlaceId, unlinkedPlaceId, pendingPlaceId);

    // A registered push token for placeUserId so the createOffer push-after-commit
    // test below has somewhere to deliver to (pushAfterCommit is a no-op with none).
    await db.insert(schema.pushTokens).values({
      token: "ExponentPushToken[sourcing-place-device]",
      userId: placeUserId,
      platform: "ios",
    });
  });

  afterAll(async () => {
    await db.delete(schema.pushTokens).where(eq(schema.pushTokens.userId, placeUserId));
    await db.delete(schema.messages).where(eq(schema.messages.senderUserId, placeUserId));
    for (const id of seededConversationIds) {
      await db.delete(schema.messages).where(eq(schema.messages.conversationId, id));
      await db.delete(schema.sourcingRequests).where(eq(schema.sourcingRequests.conversationId, id));
      await db.delete(schema.conversations).where(eq(schema.conversations.id, id));
    }
    for (const id of seededPlaceIds) {
      await db.delete(schema.communityPlaces).where(eq(schema.communityPlaces.id, id));
    }
    for (const id of seededStoreIds) {
      await db.delete(schema.listings).where(eq(schema.listings.storeId, id));
      await db.delete(schema.locations).where(eq(schema.locations.storeId, id));
      await db.delete(schema.stores).where(eq(schema.stores.id, id));
    }
    for (const id of seededUserIds) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await client.end();
  });

  // -------------------------------------------------------------------------
  // createRequest
  // -------------------------------------------------------------------------

  let req1Id: string;
  let sharedConversationId: string;

  it("createRequest: happy path creates a conversation + a card message + the DTO", async () => {
    const caller = createCaller(ctxFor(placeUserId));

    const result = await caller.sourcing.createRequest({
      storeId: growerStoreId,
      produce: "Tomatoes",
      quantity: "20 lb",
      neededBy: "2026-07-17",
      note: "For the Saturday market",
    });

    req1Id = result.request.id;
    sharedConversationId = result.conversationId;
    seededConversationIds.push(sharedConversationId);

    expect(result.request).toMatchObject({
      direction: "place_to_grower",
      status: "pending",
      placeId: coopPlaceId,
      placeName: coopPlaceName,
      storeId: growerStoreId,
      storeName: growerStoreName,
      conversationId: sharedConversationId,
      produce: "Tomatoes",
      quantity: "20 lb",
      neededBy: "2026-07-17",
      note: "For the Saturday market",
      createdByUserId: placeUserId,
      respondedAt: null,
    });

    const [msg] = await db
      .select({ body: schema.messages.body, sourcingRequestId: schema.messages.sourcingRequestId })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, sharedConversationId));
    expect(msg?.sourcingRequestId).toBe(req1Id);
    expect(msg?.body).toBe("Fulfillment request: 20 lb of Tomatoes — needed by 2026-07-17");

    const [conv] = await db
      .select({ lastMessageAt: schema.conversations.lastMessageAt })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, sharedConversationId));
    expect(conv?.lastMessageAt).not.toBeNull();
  });

  it("createRequest: a non-linked caller gets NOT_FOUND", async () => {
    const caller = createCaller(ctxFor(growerUserId));
    await expect(
      caller.sourcing.createRequest({ storeId: growerStoreId, produce: "Corn", quantity: "5 bushels" }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("createRequest: targeting the caller's own store gets BAD_REQUEST", async () => {
    const caller = createCaller(ctxFor(placeUserId));
    await expect(
      caller.sourcing.createRequest({ storeId: selfOwnedStoreId, produce: "Corn", quantity: "5 bushels" }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  it("createRequest: a blocked pair (place buyer <-> store owner) gets FORBIDDEN", async () => {
    await db.insert(schema.userBlocks).values({
      blockerUserId: growerUserId,
      blockedUserId: placeUserId,
    });

    const caller = createCaller(ctxFor(placeUserId));
    await expect(
      caller.sourcing.createRequest({ storeId: growerStoreId, produce: "Kale", quantity: "5 lb" }),
    ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));

    // Clean up so the shared placeUser/growerStore conversation used by the
    // rest of this suite still works.
    await db
      .delete(schema.userBlocks)
      .where(
        and(eq(schema.userBlocks.blockerUserId, growerUserId), eq(schema.userBlocks.blockedUserId, placeUserId)),
      );
  });

  // -------------------------------------------------------------------------
  // createOffer
  // -------------------------------------------------------------------------

  it("createOffer: happy path rides the SAME conversation as createRequest", async () => {
    const caller = createCaller(ctxFor(growerUserId));

    const result = await caller.sourcing.createOffer({
      placeId: coopPlaceId,
      produce: "Basil",
      quantity: "6 flats",
      neededBy: "2026-08-01",
    });

    expect(result.conversationId).toBe(sharedConversationId);
    expect(result.request).toMatchObject({
      direction: "grower_to_place",
      status: "pending",
      placeId: coopPlaceId,
      storeId: growerStoreId,
      produce: "Basil",
      quantity: "6 flats",
      neededBy: "2026-08-01",
      createdByUserId: growerUserId,
    });

    expect(pushCalls.length).toBeGreaterThan(0);
    const call = pushCalls[pushCalls.length - 1]!;
    expect(call.title).toBe(growerStoreName);
  });

  it("createOffer: an unlinked (but approved) place gets NOT_FOUND", async () => {
    const caller = createCaller(ctxFor(growerUserId));
    await expect(
      caller.sourcing.createOffer({ placeId: unlinkedPlaceId, produce: "Eggs", quantity: "10 dozen" }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("createOffer: a pending place gets NOT_FOUND", async () => {
    const caller = createCaller(ctxFor(growerUserId));
    await expect(
      caller.sourcing.createOffer({ placeId: pendingPlaceId, produce: "Eggs", quantity: "10 dozen" }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("createOffer: a blocked pair (place buyer <-> store owner) gets FORBIDDEN", async () => {
    await db.insert(schema.userBlocks).values({
      blockerUserId: placeUserId,
      blockedUserId: growerUserId,
    });

    const caller = createCaller(ctxFor(growerUserId));
    await expect(
      caller.sourcing.createOffer({ placeId: coopPlaceId, produce: "Kale", quantity: "5 lb" }),
    ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));

    // Clean up so the shared placeUser/growerStore conversation used by the
    // rest of this suite still works.
    await db
      .delete(schema.userBlocks)
      .where(
        and(eq(schema.userBlocks.blockerUserId, placeUserId), eq(schema.userBlocks.blockedUserId, growerUserId)),
      );
  });

  // -------------------------------------------------------------------------
  // respond
  // -------------------------------------------------------------------------

  let req2Id: string;

  it("respond: the counterparty (store owner) accepts, flips status, and appends a follow-up message", async () => {
    const growerCaller = createCaller(ctxFor(growerUserId));

    const updated = await growerCaller.sourcing.respond({ requestId: req1Id, response: "accepted" });
    expect(updated.status).toBe("accepted");
    expect(updated.respondedAt).not.toBeNull();

    const followUps = await db
      .select({ body: schema.messages.body, sourcingRequestId: schema.messages.sourcingRequestId })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, sharedConversationId));
    const followUp = followUps.find((m) => m.body === "Accepted the fulfillment request: 20 lb of Tomatoes");
    expect(followUp).toBeDefined();
    expect(followUp?.sourcingRequestId).toBeNull();
  });

  it("respond: the creator (not the counterparty) gets NOT_FOUND", async () => {
    const placeCaller = createCaller(ctxFor(placeUserId));
    const created = await placeCaller.sourcing.createRequest({
      storeId: growerStoreId,
      produce: "Squash",
      quantity: "10 lb",
    });
    req2Id = created.request.id;

    await expect(placeCaller.sourcing.respond({ requestId: req2Id, response: "accepted" })).rejects.toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("respond: responding to a non-pending request gets BAD_REQUEST", async () => {
    const growerCaller = createCaller(ctxFor(growerUserId));
    // req1 was already accepted above.
    await expect(growerCaller.sourcing.respond({ requestId: req1Id, response: "declined" })).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });

  // -------------------------------------------------------------------------
  // withdraw
  // -------------------------------------------------------------------------

  it("withdraw: the creator withdraws a pending request", async () => {
    const placeCaller = createCaller(ctxFor(placeUserId));

    const updated = await placeCaller.sourcing.withdraw({ requestId: req2Id });
    expect(updated.status).toBe("withdrawn");

    const followUps = await db
      .select({ body: schema.messages.body })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, sharedConversationId));
    expect(followUps.some((m) => m.body === "Withdrew the fulfillment request: 10 lb of Squash")).toBe(true);
  });

  it("withdraw: a non-creator gets NOT_FOUND", async () => {
    const placeCaller = createCaller(ctxFor(placeUserId));
    const created = await placeCaller.sourcing.createRequest({
      storeId: growerStoreId,
      produce: "Peppers",
      quantity: "8 lb",
    });

    const growerCaller = createCaller(ctxFor(growerUserId));
    await expect(growerCaller.sourcing.withdraw({ requestId: created.request.id })).rejects.toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("withdraw: withdrawing a non-pending request gets BAD_REQUEST", async () => {
    const placeCaller = createCaller(ctxFor(placeUserId));
    // req2 was already withdrawn above.
    await expect(placeCaller.sourcing.withdraw({ requestId: req2Id })).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });

  // -------------------------------------------------------------------------
  // listMine
  // -------------------------------------------------------------------------

  it("listMine: returns rows for both the place-buyer role and the store-owner role", async () => {
    const placeCaller = createCaller(ctxFor(placeUserId));
    const growerCaller = createCaller(ctxFor(growerUserId));

    const placeMine = await placeCaller.sourcing.listMine();
    expect(placeMine.length).toBeGreaterThanOrEqual(3);
    expect(placeMine.every((r) => r.placeId === coopPlaceId)).toBe(true);

    const growerMine = await growerCaller.sourcing.listMine();
    expect(growerMine.length).toBeGreaterThanOrEqual(3);
    expect(growerMine.every((r) => r.storeId === growerStoreId)).toBe(true);

    const strangerCaller = createCaller(ctxFor(strangerUserId));
    const strangerMine = await strangerCaller.sourcing.listMine();
    expect(strangerMine).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // growers
  // -------------------------------------------------------------------------

  it("growers: distance-ordered, aggregates listingCount + sampleListings, includes zero-listing stores", async () => {
    const placeCaller = createCaller(ctxFor(placeUserId));

    const results = await placeCaller.sourcing.growers({ lat: COOP_LAT, lng: COOP_LNG, radiusKm: 20 });
    const ids = results.map((r) => r.storeId);
    expect(ids.indexOf(growerStoreId)).toBeLessThan(ids.indexOf(growerStore2Id));

    const grower = results.find((r) => r.storeId === growerStoreId);
    expect(grower?.listingCount).toBe(4);
    expect(grower?.sampleListings).toHaveLength(3);
    // Newest-first: Honey (i=3) was inserted last.
    expect(grower?.sampleListings[0]).toBe("Honey");

    const grower2 = results.find((r) => r.storeId === growerStore2Id);
    expect(grower2?.listingCount).toBe(0);
    expect(grower2?.sampleListings).toEqual([]);
  });

  it("growers: a non-linked caller gets NOT_FOUND", async () => {
    const strangerCaller = createCaller(ctxFor(strangerUserId));
    await expect(strangerCaller.sourcing.growers({ lat: COOP_LAT, lng: COOP_LNG, radiusKm: 20 })).rejects.toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  // -------------------------------------------------------------------------
  // chat.messages — sourcingRequest embedding
  // -------------------------------------------------------------------------

  it("chat.messages: the originating message carries the request DTO; follow-ups carry null", async () => {
    const placeCaller = createCaller(ctxFor(placeUserId));
    const page = await placeCaller.chat.messages({ conversationId: sharedConversationId, limit: 50 });

    const req1Card = page.items.find((m) => m.sourcingRequest?.id === req1Id);
    expect(req1Card).toBeDefined();
    expect(req1Card?.sourcingRequest).toMatchObject({
      id: req1Id,
      direction: "place_to_grower",
      status: "accepted",
      produce: "Tomatoes",
    });

    const followUp = page.items.find((m) => m.body === "Accepted the fulfillment request: 20 lb of Tomatoes");
    expect(followUp?.sourcingRequest).toBeNull();
  });

  // -------------------------------------------------------------------------
  // places.nearby — acceptsOffers
  // -------------------------------------------------------------------------

  it("places.nearby: acceptsOffers is true for a linked place, false for an unlinked one", async () => {
    const caller = createCaller(ctxFor(null));
    const results = await caller.places.nearby({ lat: COOP_LAT, lng: COOP_LNG, radiusKm: 1 });

    const linked = results.find((r) => r.id === coopPlaceId);
    const unlinked = results.find((r) => r.id === unlinkedPlaceId);
    expect(linked?.acceptsOffers).toBe(true);
    expect(unlinked?.acceptsOffers).toBe(false);
  });

  // -------------------------------------------------------------------------
  // places.mine
  // -------------------------------------------------------------------------

  it("places.mine: returns the linked place for a linked caller", async () => {
    const caller = createCaller(ctxFor(placeUserId));
    const mine = await caller.places.mine();
    expect(mine).toMatchObject({ id: coopPlaceId, name: coopPlaceName, type: "coop" });
  });

  it("places.mine: returns null for a caller with no linked place", async () => {
    const caller = createCaller(ctxFor(growerUserId));
    const mine = await caller.places.mine();
    expect(mine).toBeNull();
  });
});
