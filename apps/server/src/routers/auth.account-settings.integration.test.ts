/**
 * Postgres integration tests for F-051 account settings.
 *
 * GUARDED — only runs when TEST_DATABASE_URL is set (mirrors
 * chat.integration.test.ts / sourcing.integration.test.ts). To run locally:
 *
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
 *     pnpm --filter @homegrown/server test src/routers/auth.account-settings.integration.test.ts
 *
 * Covers:
 *   - auth.changePassword: happy path (old password stops working, new one
 *     logs in), wrong-current-password UNAUTHORIZED, new-password-rules
 *     validation (too short -> BAD_REQUEST).
 *   - auth.deleteAccount: happy path (deactivatedAt/deleteAfter set,
 *     deleteAfter ~= +30d, push tokens deleted, the caller's own PENDING
 *     sourcing request withdrawn); wrong password -> UNAUTHORIZED (account
 *     untouched); refusal with a non-terminal order as BUYER; refusal with a
 *     non-terminal order as the owning STORE.
 *   - auth.login: self-restores a deactivated account within the 30-day
 *     grace window; generic UNAUTHORIZED once past grace (no state leak).
 *   - The deactivation predicate (helpers.ts's activeUserClause /
 *     isUserDeactivated) hides a deactivated seller from listings.nearby,
 *     sourcing.growers, stores.get, garden.feed, and flips places.nearby's
 *     acceptsOffers to false — and blocks NEW writes that would notify them
 *     (chat.start, chat.send — existing thread stays readable — ,
 *     sourcing.createRequest, sourcing.createOffer, sourcing.respond).
 *   - chat.listBlocked / chat.unblockUser: round-trip + idempotent unblock.
 *   - chat.unregisterPushToken: deletes only the caller's own token; a
 *     token belonging to someone else (or that never existed) is a silent
 *     no-op.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql, inArray } from "drizzle-orm";
import { migrateForTest } from "../db/migrate-for-test";
import * as schema from "../db/schema";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context, PushClient } from "../context";
import * as authHelpers from "../auth";

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("account settings (F-051) — Postgres integration", () => {
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
  const capturingPush: PushClient = { async send() {} };

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

  const ORIGIN_LAT = 37.7749;
  const ORIGIN_LNG = -122.4194;

  // -------------------------------------------------------------------------
  // Seed helpers
  // -------------------------------------------------------------------------

  async function seedUser(email: string, username: string): Promise<string> {
    const [u] = await db
      .insert(schema.users)
      .values({ email, username, passwordHash: "x" })
      .returning({ id: schema.users.id });
    if (!u) throw new Error("Failed to seed user");
    seededUserIds.push(u.id);
    return u.id;
  }

  async function seedStoreWithLocation(
    userId: string,
    name: string,
    lat: number,
    lng: number,
  ): Promise<string> {
    const [s] = await db
      .insert(schema.stores)
      .values({ userId, name })
      .returning({ id: schema.stores.id });
    if (!s) throw new Error("Failed to seed store");
    seededStoreIds.push(s.id);
    await db.insert(schema.locations).values({
      storeId: s.id,
      address: "1 Test St",
      city: "San Francisco",
      state: "CA",
      zip: "94102",
      geog: sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`,
    });
    return s.id;
  }

  async function seedApprovedPlace(
    name: string,
    sourceRef: string,
    linkedUserId: string,
  ): Promise<string> {
    const [p] = await db
      .insert(schema.communityPlaces)
      .values({
        type: "coop",
        name,
        location: sql`ST_SetSRID(ST_MakePoint(${ORIGIN_LNG}, ${ORIGIN_LAT}), 4326)::geography`,
        status: "approved",
        source: "manual",
        sourceRef,
        linkedUserId,
      })
      .returning({ id: schema.communityPlaces.id });
    if (!p) throw new Error("Failed to seed place");
    seededPlaceIds.push(p.id);
    return p.id;
  }

  async function deactivate(userId: string): Promise<void> {
    await db
      .update(schema.users)
      .set({
        deactivatedAt: new Date(),
        deleteAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .where(eq(schema.users.id, userId));
  }

  async function restore(userId: string): Promise<void> {
    await db
      .update(schema.users)
      .set({ deactivatedAt: null, deleteAfter: null })
      .where(eq(schema.users.id, userId));
  }

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });
    await migrateForTest(client, db);
  });

  afterAll(async () => {
    if (seededConversationIds.length > 0) {
      await db
        .delete(schema.messages)
        .where(inArray(schema.messages.conversationId, seededConversationIds));
    }
    if (seededStoreIds.length > 0) {
      await db
        .delete(schema.sourcingRequests)
        .where(inArray(schema.sourcingRequests.storeId, seededStoreIds));
    }
    if (seededConversationIds.length > 0) {
      await db
        .delete(schema.conversations)
        .where(inArray(schema.conversations.id, seededConversationIds));
    }
    if (seededStoreIds.length > 0) {
      await db
        .delete(schema.gardenPosts)
        .where(inArray(schema.gardenPosts.storeId, seededStoreIds));
      await db.delete(schema.listings).where(inArray(schema.listings.storeId, seededStoreIds));
      await db.delete(schema.locations).where(inArray(schema.locations.storeId, seededStoreIds));
      await db.delete(schema.orders).where(inArray(schema.orders.storeId, seededStoreIds));
    }
    if (seededUserIds.length > 0) {
      await db.delete(schema.orders).where(inArray(schema.orders.buyerId, seededUserIds));
      await db.delete(schema.pushTokens).where(inArray(schema.pushTokens.userId, seededUserIds));
      await db
        .delete(schema.userBlocks)
        .where(inArray(schema.userBlocks.blockerUserId, seededUserIds));
      await db
        .delete(schema.userBlocks)
        .where(inArray(schema.userBlocks.blockedUserId, seededUserIds));
    }
    if (seededPlaceIds.length > 0) {
      await db
        .delete(schema.communityPlaces)
        .where(inArray(schema.communityPlaces.id, seededPlaceIds));
    }
    if (seededStoreIds.length > 0) {
      await db.delete(schema.stores).where(inArray(schema.stores.id, seededStoreIds));
    }
    if (seededUserIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, seededUserIds));
    }
    await client.end();
  });

  // ---------------------------------------------------------------------------
  // auth.changePassword
  // ---------------------------------------------------------------------------

  describe("auth.changePassword", () => {
    it("happy path: old password stops working, new password logs in", async () => {
      const reg = await createCaller(ctxFor(null)).auth.register({
        email: "cp-happy@test.invalid",
        username: "cphappy",
        password: "OldPass123!",
      });
      seededUserIds.push(reg.user.id);

      const caller = createCaller(ctxFor(reg.user.id));
      await expect(
        caller.auth.changePassword({ currentPassword: "OldPass123!", newPassword: "NewPass456!" }),
      ).resolves.toEqual({ success: true });

      const anon = createCaller(ctxFor(null));
      await expect(
        anon.auth.login({ usernameOrEmail: "cphappy", password: "OldPass123!" }),
      ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));

      await expect(
        anon.auth.login({ usernameOrEmail: "cphappy", password: "NewPass456!" }),
      ).resolves.toMatchObject({ user: { id: reg.user.id } });
    });

    it("wrong current password -> UNAUTHORIZED", async () => {
      const reg = await createCaller(ctxFor(null)).auth.register({
        email: "cp-wrong@test.invalid",
        username: "cpwrong",
        password: "OldPass123!",
      });
      seededUserIds.push(reg.user.id);

      const caller = createCaller(ctxFor(reg.user.id));
      await expect(
        caller.auth.changePassword({
          currentPassword: "TotallyWrong1!",
          newPassword: "NewPass456!",
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
    });

    it("rejects a new password that fails the shared password rules (too short)", async () => {
      const reg = await createCaller(ctxFor(null)).auth.register({
        email: "cp-rules@test.invalid",
        username: "cprules",
        password: "OldPass123!",
      });
      seededUserIds.push(reg.user.id);

      const caller = createCaller(ctxFor(reg.user.id));
      await expect(
        caller.auth.changePassword({ currentPassword: "OldPass123!", newPassword: "short" }),
      ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
    });
  });

  // ---------------------------------------------------------------------------
  // auth.deleteAccount
  // ---------------------------------------------------------------------------

  describe("auth.deleteAccount", () => {
    it("happy path: sets deactivatedAt/deleteAfter (~+30d), deletes push tokens, withdraws the caller's own pending sourcing request", async () => {
      const reg = await createCaller(ctxFor(null)).auth.register({
        email: "da-happy@test.invalid",
        username: "dahappy",
        password: "DeleteMe123!",
      });
      seededUserIds.push(reg.user.id);
      const caller = createCaller(ctxFor(reg.user.id));

      await caller.chat.registerPushToken({
        token: "ExponentPushToken[da-happy]",
        platform: "ios",
      });

      // A pending sourcing request CREATED BY this user (as the place buyer),
      // targeting an unrelated grower store — seeded directly (bypassing the
      // full createRequest authz/rate-limit path, which isn't what's under test).
      const growerOwnerId = await seedUser("da-happy-grower@test.invalid", "dahappygrower");
      const growerStoreId = await seedStoreWithLocation(
        growerOwnerId,
        "DA Happy Grower",
        ORIGIN_LAT,
        ORIGIN_LNG,
      );
      const placeId = await seedApprovedPlace("DA Happy Co-op", "da-happy:coop", reg.user.id);
      const [conv] = await db
        .insert(schema.conversations)
        .values({ buyerId: reg.user.id, storeId: growerStoreId })
        .returning({ id: schema.conversations.id });
      if (!conv) throw new Error("Failed to seed conversation");
      seededConversationIds.push(conv.id);
      const [reqRow] = await db
        .insert(schema.sourcingRequests)
        .values({
          direction: "place_to_grower",
          placeId,
          storeId: growerStoreId,
          conversationId: conv.id,
          produce: "Tomatoes",
          quantity: "10 lb",
          status: "pending",
          createdByUserId: reg.user.id,
        })
        .returning({ id: schema.sourcingRequests.id });
      if (!reqRow) throw new Error("Failed to seed sourcing request");

      const before = Date.now();
      const result = await caller.auth.deleteAccount({ password: "DeleteMe123!" });
      const after = Date.now();

      const deleteAfterMs = new Date(result.deleteAfter).getTime();
      expect(deleteAfterMs).toBeGreaterThan(before + 29 * 24 * 60 * 60 * 1000);
      expect(deleteAfterMs).toBeLessThan(after + 31 * 24 * 60 * 60 * 1000);

      const [row] = await db
        .select({
          deactivatedAt: schema.users.deactivatedAt,
          deleteAfter: schema.users.deleteAfter,
        })
        .from(schema.users)
        .where(eq(schema.users.id, reg.user.id))
        .limit(1);
      expect(row?.deactivatedAt).not.toBeNull();
      expect(row?.deleteAfter).not.toBeNull();

      const tokens = await db
        .select()
        .from(schema.pushTokens)
        .where(eq(schema.pushTokens.userId, reg.user.id));
      expect(tokens).toHaveLength(0);

      const [reqAfter] = await db
        .select({ status: schema.sourcingRequests.status })
        .from(schema.sourcingRequests)
        .where(eq(schema.sourcingRequests.id, reqRow.id))
        .limit(1);
      expect(reqAfter?.status).toBe("withdrawn");
    });

    it("wrong password -> UNAUTHORIZED, account untouched", async () => {
      const reg = await createCaller(ctxFor(null)).auth.register({
        email: "da-wrong@test.invalid",
        username: "dawrong",
        password: "DeleteMe123!",
      });
      seededUserIds.push(reg.user.id);
      const caller = createCaller(ctxFor(reg.user.id));

      await expect(caller.auth.deleteAccount({ password: "NotItAtAll1!" })).rejects.toThrow(
        expect.objectContaining({ code: "UNAUTHORIZED" }),
      );

      const [row] = await db
        .select({ deactivatedAt: schema.users.deactivatedAt })
        .from(schema.users)
        .where(eq(schema.users.id, reg.user.id))
        .limit(1);
      expect(row?.deactivatedAt).toBeNull();
    });

    it("refuses (BAD_REQUEST) when the caller has a non-terminal order as BUYER", async () => {
      const reg = await createCaller(ctxFor(null)).auth.register({
        email: "da-buyer-open@test.invalid",
        username: "dabuyeropen",
        password: "DeleteMe123!",
      });
      seededUserIds.push(reg.user.id);

      const sellerId = await seedUser("da-buyer-open-seller@test.invalid", "dabuyeropenseller");
      const storeId = await seedStoreWithLocation(
        sellerId,
        "DA Buyer-Open Store",
        ORIGIN_LAT,
        ORIGIN_LNG,
      );
      await db.insert(schema.orders).values({
        storeId,
        buyerId: reg.user.id,
        status: "paid",
        subtotalCents: 1000,
        applicationFeeCents: 100,
        totalCents: 1000,
      });

      const caller = createCaller(ctxFor(reg.user.id));
      await expect(caller.auth.deleteAccount({ password: "DeleteMe123!" })).rejects.toThrow(
        expect.objectContaining({ code: "BAD_REQUEST" }),
      );

      const [row] = await db
        .select({ deactivatedAt: schema.users.deactivatedAt })
        .from(schema.users)
        .where(eq(schema.users.id, reg.user.id))
        .limit(1);
      expect(row?.deactivatedAt).toBeNull();
    });

    it("refuses (BAD_REQUEST) when the caller has a non-terminal order as the owning STORE", async () => {
      const reg = await createCaller(ctxFor(null)).auth.register({
        email: "da-seller-open@test.invalid",
        username: "dasellopen",
        password: "DeleteMe123!",
      });
      seededUserIds.push(reg.user.id);
      const storeId = await seedStoreWithLocation(
        reg.user.id,
        "DA Seller-Open Store",
        ORIGIN_LAT,
        ORIGIN_LNG,
      );

      const buyerId = await seedUser("da-seller-open-buyer@test.invalid", "dasellopenbuyer");
      await db.insert(schema.orders).values({
        storeId,
        buyerId,
        status: "pending_payment",
        subtotalCents: 500,
        applicationFeeCents: 50,
        totalCents: 500,
      });

      const caller = createCaller(ctxFor(reg.user.id));
      await expect(caller.auth.deleteAccount({ password: "DeleteMe123!" })).rejects.toThrow(
        expect.objectContaining({ code: "BAD_REQUEST" }),
      );

      const [row] = await db
        .select({ deactivatedAt: schema.users.deactivatedAt })
        .from(schema.users)
        .where(eq(schema.users.id, reg.user.id))
        .limit(1);
      expect(row?.deactivatedAt).toBeNull();
    });

    it("TOCTOU regression — the open-order guard lives INSIDE the same atomic UPDATE as the deactivation write, not a separate pre-check: an order seeded immediately before the call still blocks deletion, and the OTHER teardown writes (push tokens, pending sourcing request) never land either", async () => {
      const reg = await createCaller(ctxFor(null)).auth.register({
        email: "da-toctou@test.invalid",
        username: "datoctou",
        password: "DeleteMe123!",
      });
      seededUserIds.push(reg.user.id);
      const caller = createCaller(ctxFor(reg.user.id));

      // Seed the OTHER two teardown writes so we can prove they're rolled
      // back together with the guarded UPDATE, not just that deactivatedAt
      // stays null — i.e. the guard and the rest of the teardown really are
      // one atomic transaction, exactly as the deleteAccount fix requires.
      await caller.chat.registerPushToken({
        token: "ExponentPushToken[da-toctou]",
        platform: "ios",
      });

      const placeId = await seedApprovedPlace("DA TOCTOU Co-op", "da-toctou:coop", reg.user.id);
      const growerOwnerId = await seedUser("da-toctou-grower@test.invalid", "datoctougrower");
      const growerStoreId = await seedStoreWithLocation(
        growerOwnerId,
        "DA TOCTOU Grower",
        ORIGIN_LAT,
        ORIGIN_LNG,
      );
      const [conv] = await db
        .insert(schema.conversations)
        .values({ buyerId: reg.user.id, storeId: growerStoreId })
        .returning({ id: schema.conversations.id });
      if (!conv) throw new Error("Failed to seed conversation");
      seededConversationIds.push(conv.id);
      const [reqRow] = await db
        .insert(schema.sourcingRequests)
        .values({
          direction: "place_to_grower",
          placeId,
          storeId: growerStoreId,
          conversationId: conv.id,
          produce: "Kale",
          quantity: "5 lb",
          status: "pending",
          createdByUserId: reg.user.id,
        })
        .returning({ id: schema.sourcingRequests.id });
      if (!reqRow) throw new Error("Failed to seed sourcing request");

      // The order that must block deletion — seeded right before the call,
      // simulating "created in the gap" as closely as a sequential test can:
      // with the OLD (pre-check-then-transaction) implementation this order
      // existing at all would have been enough to prove the bug is fixed;
      // the point here is that the SAME guarded UPDATE also protects the
      // other two writes atomically, which a separate pre-check never could.
      const sellerId = await seedUser("da-toctou-seller@test.invalid", "datoctouseller");
      const storeId = await seedStoreWithLocation(
        sellerId,
        "DA TOCTOU Seller Store",
        ORIGIN_LAT,
        ORIGIN_LNG,
      );
      await db.insert(schema.orders).values({
        storeId,
        buyerId: reg.user.id,
        status: "paid",
        subtotalCents: 1000,
        applicationFeeCents: 100,
        totalCents: 1000,
      });

      await expect(caller.auth.deleteAccount({ password: "DeleteMe123!" })).rejects.toThrow(
        expect.objectContaining({ code: "BAD_REQUEST" }),
      );

      const [row] = await db
        .select({
          deactivatedAt: schema.users.deactivatedAt,
          deleteAfter: schema.users.deleteAfter,
        })
        .from(schema.users)
        .where(eq(schema.users.id, reg.user.id))
        .limit(1);
      expect(row?.deactivatedAt).toBeNull();
      expect(row?.deleteAfter).toBeNull();

      const tokens = await db
        .select()
        .from(schema.pushTokens)
        .where(eq(schema.pushTokens.userId, reg.user.id));
      expect(tokens).toHaveLength(1);

      const [reqAfter] = await db
        .select({ status: schema.sourcingRequests.status })
        .from(schema.sourcingRequests)
        .where(eq(schema.sourcingRequests.id, reqRow.id))
        .limit(1);
      expect(reqAfter?.status).toBe("pending");
    });
  });

  // ---------------------------------------------------------------------------
  // auth.login — deactivated account self-restore / rejection
  // ---------------------------------------------------------------------------

  describe("auth.login — deactivated account", () => {
    it("self-restores a deactivated account when logging in within the grace window", async () => {
      const reg = await createCaller(ctxFor(null)).auth.register({
        email: "restore@test.invalid",
        username: "restoreuser",
        password: "RestoreMe123!",
      });
      seededUserIds.push(reg.user.id);

      await createCaller(ctxFor(reg.user.id)).auth.deleteAccount({ password: "RestoreMe123!" });

      const anon = createCaller(ctxFor(null));
      const loginResult = await anon.auth.login({
        usernameOrEmail: "restoreuser",
        password: "RestoreMe123!",
      });
      expect(loginResult.user.id).toBe(reg.user.id);

      const [row] = await db
        .select({
          deactivatedAt: schema.users.deactivatedAt,
          deleteAfter: schema.users.deleteAfter,
        })
        .from(schema.users)
        .where(eq(schema.users.id, reg.user.id))
        .limit(1);
      expect(row?.deactivatedAt).toBeNull();
      expect(row?.deleteAfter).toBeNull();
    });

    it("rejects with a generic UNAUTHORIZED once past the grace window (no state leak)", async () => {
      const reg = await createCaller(ctxFor(null)).auth.register({
        email: "pastgrace@test.invalid",
        username: "pastgrace",
        password: "PastGrace123!",
      });
      seededUserIds.push(reg.user.id);

      // Simulate "past grace" directly — a real 30-day wait isn't feasible in a test.
      await db
        .update(schema.users)
        .set({
          deactivatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
          deleteAfter: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        })
        .where(eq(schema.users.id, reg.user.id));

      const anon = createCaller(ctxFor(null));
      await expect(
        anon.auth.login({ usernameOrEmail: "pastgrace", password: "PastGrace123!" }),
      ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));

      // Same generic message a wrong password would get — no distinguishing state leak.
      const wrongPasswordErr = await createCaller(ctxFor(null))
        .auth.login({ usernameOrEmail: "pastgrace", password: "DefinitelyWrong1!" })
        .catch((e: unknown) => e);
      const pastGraceErr = await anon.auth
        .login({ usernameOrEmail: "pastgrace", password: "PastGrace123!" })
        .catch((e: unknown) => e);
      expect((pastGraceErr as { message?: string }).message).toBe(
        (wrongPasswordErr as { message?: string }).message,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Deactivation hides selling surfaces + blocks new writes to a deactivated party
  // ---------------------------------------------------------------------------

  describe("deactivation hides selling surfaces and blocks new writes", () => {
    let targetUserId: string;
    let targetStoreId: string;
    let buyerUserId: string;
    let placeBuyerUserId: string;
    let placeId: string;

    beforeAll(async () => {
      targetUserId = await seedUser("hide-target@test.invalid", "hidetarget");
      targetStoreId = await seedStoreWithLocation(
        targetUserId,
        "Hide Target Farm",
        ORIGIN_LAT,
        ORIGIN_LNG,
      );
      await db.insert(schema.listings).values({
        storeId: targetStoreId,
        name: "Hide Tomatoes",
        category: "vegetable",
        priceCents: 100,
        quantity: 5,
        unit: "lb",
      });
      await db.insert(schema.gardenPosts).values({
        storeId: targetStoreId,
        type: "photo_set",
        status: "ready",
        caption: "hi",
        photos: [{ url: "https://example.com/a.jpg" }],
      });

      buyerUserId = await seedUser("hide-buyer@test.invalid", "hidebuyer");

      placeBuyerUserId = await seedUser("hide-place@test.invalid", "hideplace");
      placeId = await seedApprovedPlace("Hide Test Co-op", "hide-test:coop", placeBuyerUserId);
    });

    it("listings.nearby excludes a deactivated seller's listings", async () => {
      const caller = createCaller(ctxFor(null));
      const before = await caller.listings.nearby({
        lat: ORIGIN_LAT,
        lng: ORIGIN_LNG,
        radiusKm: 10,
      });
      expect(before.map((r) => r.storeId)).toContain(targetStoreId);

      await deactivate(targetUserId);
      const after = await caller.listings.nearby({
        lat: ORIGIN_LAT,
        lng: ORIGIN_LNG,
        radiusKm: 10,
      });
      expect(after.map((r) => r.storeId)).not.toContain(targetStoreId);
      await restore(targetUserId);
    });

    it("garden.feed excludes a deactivated seller's posts", async () => {
      const caller = createCaller(ctxFor(null));
      const before = await caller.garden.feed({ lat: ORIGIN_LAT, lng: ORIGIN_LNG, radiusKm: 10 });
      expect(before.items.map((i) => i.storeId)).toContain(targetStoreId);

      await deactivate(targetUserId);
      const after = await caller.garden.feed({ lat: ORIGIN_LAT, lng: ORIGIN_LNG, radiusKm: 10 });
      expect(after.items.map((i) => i.storeId)).not.toContain(targetStoreId);
      await restore(targetUserId);
    });

    it("stores.get returns NOT_FOUND for a deactivated seller's public profile", async () => {
      const caller = createCaller(ctxFor(null));
      await expect(caller.stores.get({ storeId: targetStoreId })).resolves.toMatchObject({
        id: targetStoreId,
      });

      await deactivate(targetUserId);
      await expect(caller.stores.get({ storeId: targetStoreId })).rejects.toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
      await restore(targetUserId);
    });

    it("sourcing.growers excludes a deactivated grower", async () => {
      const placeCaller = createCaller(ctxFor(placeBuyerUserId));
      const before = await placeCaller.sourcing.growers({
        lat: ORIGIN_LAT,
        lng: ORIGIN_LNG,
        radiusKm: 10,
      });
      expect(before.map((r) => r.storeId)).toContain(targetStoreId);

      await deactivate(targetUserId);
      const after = await placeCaller.sourcing.growers({
        lat: ORIGIN_LAT,
        lng: ORIGIN_LNG,
        radiusKm: 10,
      });
      expect(after.map((r) => r.storeId)).not.toContain(targetStoreId);
      await restore(targetUserId);
    });

    it("places.nearby: acceptsOffers flips to false when the linked user is deactivated", async () => {
      const caller = createCaller(ctxFor(null));
      const before = await caller.places.nearby({ lat: ORIGIN_LAT, lng: ORIGIN_LNG, radiusKm: 10 });
      expect(before.find((p) => p.id === placeId)?.acceptsOffers).toBe(true);

      await deactivate(placeBuyerUserId);
      const after = await caller.places.nearby({ lat: ORIGIN_LAT, lng: ORIGIN_LNG, radiusKm: 10 });
      expect(after.find((p) => p.id === placeId)?.acceptsOffers).toBe(false);
      await restore(placeBuyerUserId);
    });

    it("chat.start: NOT_FOUND when the target store's owner is deactivated", async () => {
      await deactivate(targetUserId);
      const caller = createCaller(ctxFor(buyerUserId));
      await expect(caller.chat.start({ storeId: targetStoreId })).rejects.toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
      await restore(targetUserId);
    });

    it("chat.send: NOT_FOUND to a since-deactivated recipient; the existing thread stays readable", async () => {
      const buyerCaller = createCaller(ctxFor(buyerUserId));
      const { conversationId } = await buyerCaller.chat.start({ storeId: targetStoreId });
      seededConversationIds.push(conversationId);
      await buyerCaller.chat.send({ conversationId, body: "hi there" });

      await deactivate(targetUserId);

      await expect(buyerCaller.chat.send({ conversationId, body: "still there?" })).rejects.toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
      // Existing thread stays readable — only sending a NEW message is blocked.
      await expect(buyerCaller.chat.messages({ conversationId })).resolves.toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({ body: "hi there" })]),
      });
      await restore(targetUserId);
    });

    it("sourcing.createRequest: NOT_FOUND when the target grower is deactivated", async () => {
      await deactivate(targetUserId);
      const placeCaller = createCaller(ctxFor(placeBuyerUserId));
      await expect(
        placeCaller.sourcing.createRequest({
          storeId: targetStoreId,
          produce: "Tomatoes",
          quantity: "10 lb",
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
      await restore(targetUserId);
    });

    it("sourcing.createOffer: NOT_FOUND when the target place's linked buyer is deactivated", async () => {
      await deactivate(placeBuyerUserId);
      // targetUserId owns targetStoreId — use them as the offering grower.
      const growerCaller = createCaller(ctxFor(targetUserId));
      await expect(
        growerCaller.sourcing.createOffer({ placeId, produce: "Basil", quantity: "5 bunches" }),
      ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
      await restore(placeBuyerUserId);
    });

    it("sourcing.respond: NOT_FOUND when the request's creator has since deactivated", async () => {
      const placeCaller = createCaller(ctxFor(placeBuyerUserId));
      const created = await placeCaller.sourcing.createRequest({
        storeId: targetStoreId,
        produce: "Eggs",
        quantity: "2 dozen",
      });
      seededConversationIds.push(created.conversationId);

      await deactivate(placeBuyerUserId);

      const growerCaller = createCaller(ctxFor(targetUserId));
      await expect(
        growerCaller.sourcing.respond({ requestId: created.request.id, response: "accepted" }),
      ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
      await restore(placeBuyerUserId);
    });
  });

  // ---------------------------------------------------------------------------
  // F-051 — caller-side deactivation (helpers.ts's `assertCallerActive`).
  // Distinct from the counterparty-deactivation cases above: here the CALLER
  // itself is deactivated, which must surface UNAUTHORIZED (not NOT_FOUND —
  // that code is reserved for a deactivated COUNTERPARTY / target resource).
  // ---------------------------------------------------------------------------

  describe("caller-side deactivation blocks writes (assertCallerActive)", () => {
    it("chat.send: UNAUTHORIZED when the SENDER's own account is deactivated (existing thread, started while active)", async () => {
      const buyerId = await seedUser("cs-deactivated-buyer@test.invalid", "csdeactivatedbuyer");
      const sellerId = await seedUser(
        "cs-deactivated-buyer-seller@test.invalid",
        "csdeactivatedbuyerseller",
      );
      const storeId = await seedStoreWithLocation(
        sellerId,
        "CS Deactivated Buyer Store",
        ORIGIN_LAT,
        ORIGIN_LNG,
      );

      const buyerCaller = createCaller(ctxFor(buyerId));
      const { conversationId } = await buyerCaller.chat.start({ storeId });
      seededConversationIds.push(conversationId);

      await deactivate(buyerId);

      await expect(buyerCaller.chat.send({ conversationId, body: "hello" })).rejects.toThrow(
        expect.objectContaining({ code: "UNAUTHORIZED" }),
      );

      await restore(buyerId);
    });

    it("sourcing.createRequest: UNAUTHORIZED when the CALLER (place buyer) has deactivated their own account", async () => {
      const placeBuyerId = await seedUser(
        "sr-deactivated-place@test.invalid",
        "srdeactivatedplace",
      );
      // Not captured — assertCallerActive rejects before the place lookup is
      // ever reached, so this only needs to exist (seedApprovedPlace already
      // registers it for afterAll cleanup).
      await seedApprovedPlace("SR Deactivated Place Co-op", "sr-deactivated:coop", placeBuyerId);

      const growerOwnerId = await seedUser(
        "sr-deactivated-place-grower@test.invalid",
        "srdeactivatedplacegrower",
      );
      const growerStoreId = await seedStoreWithLocation(
        growerOwnerId,
        "SR Deactivated Place Grower",
        ORIGIN_LAT,
        ORIGIN_LNG,
      );

      await deactivate(placeBuyerId);

      const placeCaller = createCaller(ctxFor(placeBuyerId));
      await expect(
        placeCaller.sourcing.createRequest({
          storeId: growerStoreId,
          produce: "Kale",
          quantity: "5 lb",
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));

      await restore(placeBuyerId);
    });
  });

  // ---------------------------------------------------------------------------
  // orders.create — F-051 deactivation guards (BLOCKING fix — see auth.ts's
  // deleteAccount doc comment and orders.ts's module header).
  // ---------------------------------------------------------------------------

  describe("orders.create — F-051 deactivation guards", () => {
    it("UNAUTHORIZED when the caller's own account is deactivated", async () => {
      const buyerId = await seedUser("oc-deactivated-buyer@test.invalid", "ocdeactivatedbuyer");
      await deactivate(buyerId);

      const caller = createCaller(ctxFor(buyerId));
      await expect(
        caller.orders.create({
          items: [{ listingId: "00000000-0000-0000-0000-000000000000", quantity: 1 }],
          fulfillmentMethod: "pickup",
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));

      await restore(buyerId);
    });

    it("NOT_FOUND when the target store's owner has since deactivated their account", async () => {
      const sellerId = await seedUser("oc-deactivated-seller@test.invalid", "ocdeactivatedseller");
      const storeId = await seedStoreWithLocation(
        sellerId,
        "OC Deactivated Seller Store",
        ORIGIN_LAT,
        ORIGIN_LNG,
      );
      const [listing] = await db
        .insert(schema.listings)
        .values({
          storeId,
          name: "OC Test Listing",
          category: "vegetable",
          priceCents: 100,
          quantity: 5,
          unit: "lb",
        })
        .returning({ id: schema.listings.id });
      if (!listing) throw new Error("Failed to seed listing");

      const buyerId = await seedUser(
        "oc-deactivated-seller-buyer@test.invalid",
        "ocdeactivatedsellerbuyer",
      );
      await deactivate(sellerId);

      const caller = createCaller(ctxFor(buyerId));
      await expect(
        caller.orders.create({
          items: [{ listingId: listing.id, quantity: 1 }],
          fulfillmentMethod: "pickup",
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));

      await restore(sellerId);
    });
  });

  // ---------------------------------------------------------------------------
  // chat.listBlocked / chat.unblockUser
  // ---------------------------------------------------------------------------

  describe("chat.listBlocked / chat.unblockUser", () => {
    it("round-trips: block -> listBlocked shows it -> unblock -> listBlocked no longer shows it; unblock is idempotent", async () => {
      const blockerId = await seedUser("lb-blocker@test.invalid", "lbblocker");
      const blockedId = await seedUser("lb-blocked@test.invalid", "lbblocked");
      const caller = createCaller(ctxFor(blockerId));

      await caller.chat.blockUser({ userId: blockedId });

      const listed = await caller.chat.listBlocked();
      const row = listed.find((b) => b.userId === blockedId);
      expect(row).toBeDefined();
      expect(row?.username).toBe("lbblocked");

      await caller.chat.unblockUser({ userId: blockedId });
      const afterUnblock = await caller.chat.listBlocked();
      expect(afterUnblock.map((b) => b.userId)).not.toContain(blockedId);

      // Idempotent — unblocking again (already absent) does not error.
      await expect(caller.chat.unblockUser({ userId: blockedId })).resolves.toEqual({
        success: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // chat.unregisterPushToken
  // ---------------------------------------------------------------------------

  describe("chat.unregisterPushToken", () => {
    it("deletes only the caller's own token; someone else's token (or a never-registered one) is a silent no-op", async () => {
      const ownerId = await seedUser("upt-owner@test.invalid", "uptowner");
      const otherId = await seedUser("upt-other@test.invalid", "uptother");
      const token = "ExponentPushToken[upt-owner]";

      const ownerCaller = createCaller(ctxFor(ownerId));
      await ownerCaller.chat.registerPushToken({ token, platform: "ios" });

      const otherCaller = createCaller(ctxFor(otherId));
      await expect(otherCaller.chat.unregisterPushToken({ token })).resolves.toEqual({
        success: true,
      });
      const stillThere = await db
        .select()
        .from(schema.pushTokens)
        .where(eq(schema.pushTokens.token, token));
      expect(stillThere).toHaveLength(1);

      await expect(ownerCaller.chat.unregisterPushToken({ token })).resolves.toEqual({
        success: true,
      });
      const goneNow = await db
        .select()
        .from(schema.pushTokens)
        .where(eq(schema.pushTokens.token, token));
      expect(goneNow).toHaveLength(0);

      await expect(
        ownerCaller.chat.unregisterPushToken({ token: "ExponentPushToken[never-existed]" }),
      ).resolves.toEqual({ success: true });
    });
  });
});
