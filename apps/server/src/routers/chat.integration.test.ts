/**
 * Postgres integration test for the `chat` router (F-037/F-038).
 *
 * GUARDED — only runs when TEST_DATABASE_URL is set (mirrors
 * garden.feed.integration.test.ts / nearby.integration.test.ts). To run locally:
 *
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
 *     pnpm --filter @homegrown/server test src/routers/chat.integration.test.ts
 *
 * Covers:
 *   - start: idempotent upsert on (buyer, store); rejects messaging your own
 *     store; rejects when either party has blocked the other.
 *   - messages: participant-only (non-participant gets NOT_FOUND, not FORBIDDEN
 *     — existence isn't leaked); newest-first keyset pagination across 2 pages.
 *   - send: inserts a message, bumps conversations.last_message_at, rejects a
 *     blocked send with a generic FORBIDDEN; fires a push notification to the
 *     OTHER party's registered device after the write commits.
 *   - markRead + list: unreadCount reflects messages after the caller's
 *     last_read_at from the OTHER party only; markRead zeroes it.
 *   - list: a user who is a buyer in one conversation and a seller (store
 *     owner) in another sees both rows in one inbox.
 *   - blockUser: idempotent (no error on repeat); reportMessage requires the
 *     reporter be a participant of the message's conversation.
 *   - registerPushToken: re-registering an existing token moves ownership to
 *     the new user.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { migrateForTest } from "../db/migrate-for-test";
import * as schema from "../db/schema";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context, PushClient } from "../context";
import * as authHelpers from "../auth";

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

/** Poll until `predicate()` is true or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describeWithDb("chat router — Postgres integration", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;

  const seededUserIds: string[] = [];
  const seededStoreIds: string[] = [];
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

  /** Every push.send call made across the whole test file, for assertion. */
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

  // Seeded fixtures, populated in beforeAll.
  let buyerId: string, buyerUsername: string;
  let otherBuyerId: string;
  let sellerUserId: string, storeId: string, storeName: string;
  let otherSellerUserId: string, otherStoreId: string;

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });
    await migrateForTest(client, db);

    const [buyer] = await db
      .insert(schema.users)
      .values({ email: "chatbuyer@test.invalid", username: "chatbuyer", passwordHash: "x" })
      .returning({ id: schema.users.id, username: schema.users.username });
    const [otherBuyer] = await db
      .insert(schema.users)
      .values({ email: "chatbuyer2@test.invalid", username: "chatbuyer2", passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [seller] = await db
      .insert(schema.users)
      .values({ email: "chatseller@test.invalid", username: "chatseller", passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [otherSeller] = await db
      .insert(schema.users)
      .values({ email: "chatseller2@test.invalid", username: "chatseller2", passwordHash: "x" })
      .returning({ id: schema.users.id });
    if (!buyer || !otherBuyer || !seller || !otherSeller) throw new Error("Failed to seed users");

    buyerId = buyer.id;
    buyerUsername = buyer.username;
    otherBuyerId = otherBuyer.id;
    sellerUserId = seller.id;
    otherSellerUserId = otherSeller.id;
    seededUserIds.push(buyerId, otherBuyerId, sellerUserId, otherSellerUserId);

    const [store] = await db
      .insert(schema.stores)
      .values({ userId: sellerUserId, name: "Chat Test Farm" })
      .returning({ id: schema.stores.id, name: schema.stores.name });
    const [otherStore] = await db
      .insert(schema.stores)
      .values({ userId: otherSellerUserId, name: "Other Chat Farm" })
      .returning({ id: schema.stores.id });
    if (!store || !otherStore) throw new Error("Failed to seed stores");

    storeId = store.id;
    storeName = store.name;
    otherStoreId = otherStore.id;
    seededStoreIds.push(storeId, otherStoreId);
  });

  afterAll(async () => {
    // message_reports FK-reference messages — delete them first.
    await db.delete(schema.messageReports);
    for (const id of seededConversationIds) {
      await db.delete(schema.messages).where(eq(schema.messages.conversationId, id));
      await db.delete(schema.conversations).where(eq(schema.conversations.id, id));
    }
    await db.delete(schema.userBlocks);
    await db.delete(schema.pushTokens);
    for (const id of seededStoreIds) {
      await db.delete(schema.stores).where(eq(schema.stores.id, id));
    }
    for (const id of seededUserIds) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await client.end();
  });

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  it("start is idempotent: a second call returns the same conversationId", async () => {
    const caller = createCaller(ctxFor(buyerId));

    const first = await caller.chat.start({ storeId });
    const second = await caller.chat.start({ storeId });

    expect(first.conversationId).toBe(second.conversationId);
    seededConversationIds.push(first.conversationId);
  });

  it("rejects starting a conversation with your own store", async () => {
    const caller = createCaller(ctxFor(sellerUserId));

    await expect(caller.chat.start({ storeId })).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });

  it("rejects starting a conversation when the seller has blocked the buyer", async () => {
    // Seed a fresh buyer + store pair for this test so it doesn't interfere
    // with the shared conversation used elsewhere.
    const [blockedBuyer] = await db
      .insert(schema.users)
      .values({ email: "chatblocked@test.invalid", username: "chatblocked", passwordHash: "x" })
      .returning({ id: schema.users.id });
    if (!blockedBuyer) throw new Error("Failed to seed blocked buyer");
    seededUserIds.push(blockedBuyer.id);

    await db.insert(schema.userBlocks).values({
      blockerUserId: sellerUserId,
      blockedUserId: blockedBuyer.id,
    });

    const caller = createCaller(ctxFor(blockedBuyer.id));
    await expect(caller.chat.start({ storeId })).rejects.toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  // -------------------------------------------------------------------------
  // messages — participant authz + pagination
  // -------------------------------------------------------------------------

  it("messages: a non-participant gets NOT_FOUND (existence not leaked)", async () => {
    const conversationId = seededConversationIds[0]!;
    const caller = createCaller(ctxFor(otherBuyerId));

    await expect(caller.chat.messages({ conversationId })).rejects.toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("messages: an unauthenticated caller is rejected", async () => {
    const conversationId = seededConversationIds[0]!;
    const caller = createCaller(ctxFor(null));

    await expect(caller.chat.messages({ conversationId })).rejects.toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });

  it("send + messages: newest-first keyset pagination across 2 pages", async () => {
    const conversationId = seededConversationIds[0]!;
    const buyerCaller = createCaller(ctxFor(buyerId));
    const sellerCaller = createCaller(ctxFor(sellerUserId));

    const m1 = await buyerCaller.chat.send({ conversationId, body: "Hi, do you have eggs?" });
    const m2 = await sellerCaller.chat.send({ conversationId, body: "Yes! A dozen for $6." });
    const m3 = await buyerCaller.chat.send({ conversationId, body: "Great, I'll take two." });

    const page1 = await buyerCaller.chat.messages({ conversationId, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items.map((m) => m.id)).toEqual([m3.id, m2.id]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await buyerCaller.chat.messages({
      conversationId,
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.map((m) => m.id)).toEqual([m1.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it("messages: throws BAD_REQUEST on a malformed cursor", async () => {
    const conversationId = seededConversationIds[0]!;
    const caller = createCaller(ctxFor(buyerId));

    await expect(
      caller.chat.messages({ conversationId, cursor: "not-a-valid-cursor!!" }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  // -------------------------------------------------------------------------
  // send — block enforcement + push notification
  // -------------------------------------------------------------------------

  it("send: rejects with a generic FORBIDDEN when the recipient is blocked", async () => {
    const conversationId = seededConversationIds[0]!;

    await db.insert(schema.userBlocks).values({
      blockerUserId: sellerUserId,
      blockedUserId: buyerId,
    });

    const caller = createCaller(ctxFor(buyerId));
    await expect(caller.chat.send({ conversationId, body: "hello?" })).rejects.toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );

    // Clean up the block so subsequent tests in this conversation still work.
    await db
      .delete(schema.userBlocks)
      .where(eq(schema.userBlocks.blockerUserId, sellerUserId));
  });

  it("send: fires a push notification to the other party's registered device after commit", async () => {
    const conversationId = seededConversationIds[0]!;

    const sellerCaller = createCaller(ctxFor(sellerUserId));
    await sellerCaller.chat.registerPushToken({
      token: "ExponentPushToken[seller-device]",
      platform: "ios",
    });

    const buyerCaller = createCaller(ctxFor(buyerId));
    const pushCallsBefore = pushCalls.length;
    await buyerCaller.chat.send({ conversationId, body: "Push me!" });

    await waitFor(() => pushCalls.length > pushCallsBefore);
    const call = pushCalls[pushCalls.length - 1]!;
    expect(call.tokens).toContain("ExponentPushToken[seller-device]");
    expect(call.title).toBe(buyerUsername);
    expect(call.body).toBe("Push me!");
    expect(call.data).toEqual({ conversationId });
  });

  it("send: when the SELLER sends, the push title is the store name (not the seller's username)", async () => {
    const conversationId = seededConversationIds[0]!;
    const buyerCaller = createCaller(ctxFor(buyerId));
    await buyerCaller.chat.registerPushToken({
      token: "ExponentPushToken[buyer-device]",
      platform: "android",
    });

    const sellerCaller = createCaller(ctxFor(sellerUserId));
    const pushCallsBefore = pushCalls.length;
    await sellerCaller.chat.send({ conversationId, body: "Reply from the seller" });

    await waitFor(() => pushCalls.length > pushCallsBefore);
    const call = pushCalls[pushCalls.length - 1]!;
    expect(call.tokens).toContain("ExponentPushToken[buyer-device]");
    expect(call.title).toBe(storeName);
  });

  // -------------------------------------------------------------------------
  // markRead + list — unread counts, both-role inbox
  // -------------------------------------------------------------------------

  it("list: unreadCount counts only the OTHER party's messages since my last_read_at; markRead zeroes it", async () => {
    const conversationId = seededConversationIds[0]!;
    const buyerCaller = createCaller(ctxFor(buyerId));
    const sellerCaller = createCaller(ctxFor(sellerUserId));

    // Mark read from both sides first so this test starts from a clean slate.
    await buyerCaller.chat.markRead({ conversationId });
    await sellerCaller.chat.markRead({ conversationId });

    await sellerCaller.chat.send({ conversationId, body: "Still there?" });

    const buyerInboxBefore = await buyerCaller.chat.list({});
    const rowBefore = buyerInboxBefore.items.find((c) => c.id === conversationId);
    expect(rowBefore?.unreadCount).toBe(1);

    await buyerCaller.chat.markRead({ conversationId });

    const buyerInboxAfter = await buyerCaller.chat.list({});
    const rowAfter = buyerInboxAfter.items.find((c) => c.id === conversationId);
    expect(rowAfter?.unreadCount).toBe(0);
  });

  it("list: a user sees conversations both as buyer and as store owner in one inbox", async () => {
    // sellerUserId is the store owner of `storeId` (has the shared conversation)
    // AND now becomes a buyer of `otherStoreId`.
    const sellerAsBuyerCaller = createCaller(ctxFor(sellerUserId));
    const { conversationId: crossConversationId } = await sellerAsBuyerCaller.chat.start({
      storeId: otherStoreId,
    });
    seededConversationIds.push(crossConversationId);

    const inbox = await sellerAsBuyerCaller.chat.list({});
    const ids = inbox.items.map((c) => c.id);
    expect(ids).toContain(seededConversationIds[0]); // as store owner
    expect(ids).toContain(crossConversationId); // as buyer
  });

  it("list: lastMessageBody is truncated server-side and reflects the most recent message", async () => {
    const conversationId = seededConversationIds[0]!;
    const buyerCaller = createCaller(ctxFor(buyerId));

    const longBody = "x".repeat(200);
    await buyerCaller.chat.send({ conversationId, body: longBody });

    const inbox = await buyerCaller.chat.list({});
    const row = inbox.items.find((c) => c.id === conversationId);
    expect(row?.lastMessageBody?.length).toBeLessThanOrEqual(121);
    expect(row?.lastMessageBody).toBe(`${"x".repeat(120)}…`);
  });

  // -------------------------------------------------------------------------
  // blockUser / reportMessage
  // -------------------------------------------------------------------------

  it("blockUser is idempotent — repeating it does not error", async () => {
    const caller = createCaller(ctxFor(buyerId));
    await expect(caller.chat.blockUser({ userId: otherBuyerId })).resolves.toEqual({ success: true });
    await expect(caller.chat.blockUser({ userId: otherBuyerId })).resolves.toEqual({ success: true });
  });

  it("blockUser rejects blocking yourself", async () => {
    const caller = createCaller(ctxFor(buyerId));
    await expect(caller.chat.blockUser({ userId: buyerId })).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });

  it("reportMessage requires the reporter be a participant of the message's conversation", async () => {
    const conversationId = seededConversationIds[0]!;
    const buyerCaller = createCaller(ctxFor(buyerId));
    const sent = await buyerCaller.chat.send({ conversationId, body: "reportable message" });

    // A non-participant reporting the message gets NOT_FOUND.
    const strangerCaller = createCaller(ctxFor(otherBuyerId));
    await expect(
      strangerCaller.chat.reportMessage({ messageId: sent.id, reason: "spam" }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));

    // The seller (a real participant) can report it.
    const sellerCaller = createCaller(ctxFor(sellerUserId));
    await expect(
      sellerCaller.chat.reportMessage({ messageId: sent.id, reason: "spam" }),
    ).resolves.toEqual({ success: true });
  });

  // -------------------------------------------------------------------------
  // registerPushToken
  // -------------------------------------------------------------------------

  it("registerPushToken: re-registering an existing token moves ownership to the new user", async () => {
    const token = "ExponentPushToken[shared-device]";
    const buyerCaller = createCaller(ctxFor(buyerId));
    const otherBuyerCaller = createCaller(ctxFor(otherBuyerId));

    await buyerCaller.chat.registerPushToken({ token, platform: "ios" });
    const [rowAfterFirst] = await db
      .select({ userId: schema.pushTokens.userId })
      .from(schema.pushTokens)
      .where(eq(schema.pushTokens.token, token));
    expect(rowAfterFirst?.userId).toBe(buyerId);

    await otherBuyerCaller.chat.registerPushToken({ token, platform: "android" });
    const [rowAfterSecond] = await db
      .select({ userId: schema.pushTokens.userId, platform: schema.pushTokens.platform })
      .from(schema.pushTokens)
      .where(eq(schema.pushTokens.token, token));
    expect(rowAfterSecond?.userId).toBe(otherBuyerId);
    expect(rowAfterSecond?.platform).toBe("android");
  });
});
