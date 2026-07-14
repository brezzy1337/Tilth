/**
 * Postgres integration test for garden social (F-053) — likes + flat comments.
 *
 * GUARDED — only runs when TEST_DATABASE_URL is set (mirrors
 * chat.integration.test.ts / garden.feed.integration.test.ts). To run locally:
 *
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
 *     pnpm --filter @homegrown/server test src/routers/garden.social.integration.test.ts
 *
 * Covers:
 *   - toggleLike: like → unlike → idempotent-toggle count correctness;
 *     NOT_FOUND on an invisible (processing) post; UNAUTHORIZED for a
 *     deactivated caller (assertCallerActive).
 *   - createComment: happy path (username on the DTO); FORBIDDEN when the
 *     commenter and post owner block each other; push sent to the post owner
 *     (skipped when commenting on your own post); TOO_MANY_REQUESTS past
 *     30 comments/60s per commenter.
 *   - listComments: newest-first keyset pagination across 2 pages; a deleted
 *     comment holds its thread position (`deleted: true`, `body: ""`, not
 *     filtered out); comments from a deactivated author or a
 *     blocked-either-direction user are filtered out for the caller.
 *   - deleteComment: author-only (NOT_FOUND otherwise); idempotent.
 *   - reportComment: success path; NOT_FOUND for a missing comment;
 *     TOO_MANY_REQUESTS past 10 reports/hour per reporter.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import { migrateForTest } from "../db/migrate-for-test";
import * as schema from "../db/schema";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context, PushClient } from "../context";
import * as authHelpers from "../auth";

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("garden social (F-053) — Postgres integration", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;

  const seededUserIds: string[] = [];
  const seededStoreIds: string[] = [];
  const seededLocationIds: string[] = [];
  const seededPostIds: string[] = [];

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

  let ownerUserId: string, storeId: string;
  let visiblePostId: string, processingPostId: string;
  let commenterId: string, commenterUsername: string;
  let otherUserId: string;
  let deactivatedUserId: string, deactivatedCallerId: string;

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });
    await migrateForTest(client, db);

    const [owner] = await db
      .insert(schema.users)
      .values({ email: "socialowner@test.invalid", username: "socialowner", passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [commenter] = await db
      .insert(schema.users)
      .values({ email: "socialcommenter@test.invalid", username: "socialcommenter", passwordHash: "x" })
      .returning({ id: schema.users.id, username: schema.users.username });
    const [other] = await db
      .insert(schema.users)
      .values({ email: "socialother@test.invalid", username: "socialother", passwordHash: "x" })
      .returning({ id: schema.users.id });
    const [deactivatedUser] = await db
      .insert(schema.users)
      .values({
        email: "socialdeactivated@test.invalid",
        username: "socialdeactivated",
        passwordHash: "x",
        deactivatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    const [deactivatedCaller] = await db
      .insert(schema.users)
      .values({
        email: "socialdeactivatedcaller@test.invalid",
        username: "socialdeactivatedcaller",
        passwordHash: "x",
        deactivatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    if (!owner || !commenter || !other || !deactivatedUser || !deactivatedCaller) {
      throw new Error("Failed to seed users");
    }

    ownerUserId = owner.id;
    commenterId = commenter.id;
    commenterUsername = commenter.username;
    otherUserId = other.id;
    deactivatedUserId = deactivatedUser.id;
    deactivatedCallerId = deactivatedCaller.id;
    seededUserIds.push(ownerUserId, commenterId, otherUserId, deactivatedUserId, deactivatedCallerId);

    const [store] = await db
      .insert(schema.stores)
      .values({ userId: ownerUserId, name: "Social Test Farm" })
      .returning({ id: schema.stores.id });
    if (!store) throw new Error("Failed to seed store");
    storeId = store.id;
    seededStoreIds.push(storeId);

    const [location] = await db
      .insert(schema.locations)
      .values({
        storeId,
        address: "1 Social St",
        city: "San Francisco",
        state: "CA",
        zip: "94102",
        geog: sql`ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326)::geography`,
      })
      .returning({ id: schema.locations.id });
    if (!location) throw new Error("Failed to seed location");
    seededLocationIds.push(location.id);

    const [visiblePost] = await db
      .insert(schema.gardenPosts)
      .values({
        storeId,
        type: "photo_set",
        status: "ready",
        caption: "Fresh basil today",
        photos: [{ url: "https://storage.googleapis.com/bucket/basil.jpg" }],
      })
      .returning({ id: schema.gardenPosts.id });
    const [processingPost] = await db
      .insert(schema.gardenPosts)
      .values({
        storeId,
        type: "video",
        status: "processing",
        caption: "Not visible yet",
      })
      .returning({ id: schema.gardenPosts.id });
    if (!visiblePost || !processingPost) throw new Error("Failed to seed garden posts");
    visiblePostId = visiblePost.id;
    processingPostId = processingPost.id;
    seededPostIds.push(visiblePostId, processingPostId);
  });

  afterAll(async () => {
    await db.delete(schema.gardenCommentReports);
    for (const id of seededPostIds) {
      await db.delete(schema.gardenPostLikes).where(eq(schema.gardenPostLikes.postId, id));
      await db.delete(schema.gardenPostComments).where(eq(schema.gardenPostComments.postId, id));
      await db.delete(schema.gardenPosts).where(eq(schema.gardenPosts.id, id));
    }
    for (const id of seededLocationIds) {
      await db.delete(schema.locations).where(eq(schema.locations.id, id));
    }
    for (const id of seededStoreIds) {
      await db.delete(schema.stores).where(eq(schema.stores.id, id));
    }
    await db.delete(schema.userBlocks);
    await db.delete(schema.pushTokens);
    for (const id of seededUserIds) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await client.end();
  });

  // -------------------------------------------------------------------------
  // toggleLike
  // -------------------------------------------------------------------------

  describe("toggleLike", () => {
    it("likes, then unlikes (idempotent toggle), with correct count each time", async () => {
      const caller = createCaller(ctxFor(commenterId));

      const liked = await caller.garden.toggleLike({ postId: visiblePostId });
      expect(liked).toEqual({ liked: true, likeCount: 1 });

      const unliked = await caller.garden.toggleLike({ postId: visiblePostId });
      expect(unliked).toEqual({ liked: false, likeCount: 0 });

      const likedAgain = await caller.garden.toggleLike({ postId: visiblePostId });
      expect(likedAgain).toEqual({ liked: true, likeCount: 1 });

      // Clean up so later tests start from a known (unliked) state.
      await caller.garden.toggleLike({ postId: visiblePostId });
    });

    it("two different users liking the same post both count", async () => {
      const commenterCaller = createCaller(ctxFor(commenterId));
      const otherCaller = createCaller(ctxFor(otherUserId));

      const first = await commenterCaller.garden.toggleLike({ postId: visiblePostId });
      expect(first.liked).toBe(true);
      const second = await otherCaller.garden.toggleLike({ postId: visiblePostId });
      expect(second).toEqual({ liked: true, likeCount: 2 });

      // Clean up.
      await commenterCaller.garden.toggleLike({ postId: visiblePostId });
      await otherCaller.garden.toggleLike({ postId: visiblePostId });
    });

    it("NOT_FOUND on a processing (invisible) post", async () => {
      const caller = createCaller(ctxFor(commenterId));
      await expect(caller.garden.toggleLike({ postId: processingPostId })).rejects.toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    });

    it("NOT_FOUND on a nonexistent post", async () => {
      const caller = createCaller(ctxFor(commenterId));
      await expect(
        caller.garden.toggleLike({ postId: "00000000-0000-0000-0000-000000000000" }),
      ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    });

    it("UNAUTHORIZED for a deactivated caller", async () => {
      const caller = createCaller(ctxFor(deactivatedCallerId));
      await expect(caller.garden.toggleLike({ postId: visiblePostId })).rejects.toThrow(
        expect.objectContaining({ code: "UNAUTHORIZED" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // createComment
  // -------------------------------------------------------------------------

  describe("createComment", () => {
    it("happy path: returns the comment DTO with the commenter's username, and pushes the post owner", async () => {
      // Push tokens are registered via chat.ts (shared push_tokens table —
      // there is no garden-specific registration endpoint).
      await createCaller(ctxFor(ownerUserId)).chat.registerPushToken({
        token: "ExponentPushToken[social-owner-device]",
        platform: "ios",
      });

      const commenterCaller = createCaller(ctxFor(commenterId));
      const pushCallsBefore = pushCalls.length;

      const comment = await commenterCaller.garden.createComment({
        postId: visiblePostId,
        body: "This basil looks amazing!",
      });

      expect(comment.postId).toBe(visiblePostId);
      expect(comment.userId).toBe(commenterId);
      expect(comment.username).toBe(commenterUsername);
      expect(comment.body).toBe("This basil looks amazing!");
      expect(comment.deleted).toBe(false);

      expect(pushCalls.length).toBe(pushCallsBefore + 1);
      const call = pushCalls[pushCalls.length - 1]!;
      expect(call.tokens).toContain("ExponentPushToken[social-owner-device]");
      expect(call.title).toBe("New comment on your garden post");
      expect(call.body).toBe("This basil looks amazing!");
    });

    it("skips the push when the post owner comments on their own post", async () => {
      const ownerCaller = createCaller(ctxFor(ownerUserId));
      const pushCallsBefore = pushCalls.length;

      await ownerCaller.garden.createComment({ postId: visiblePostId, body: "Thanks everyone!" });

      expect(pushCalls.length).toBe(pushCallsBefore);
    });

    it("NOT_FOUND on a processing (invisible) post", async () => {
      const caller = createCaller(ctxFor(commenterId));
      await expect(
        caller.garden.createComment({ postId: processingPostId, body: "hello?" }),
      ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    });

    it("FORBIDDEN when the commenter and post owner block each other", async () => {
      await db.insert(schema.userBlocks).values({
        blockerUserId: ownerUserId,
        blockedUserId: otherUserId,
      });

      const caller = createCaller(ctxFor(otherUserId));
      await expect(
        caller.garden.createComment({ postId: visiblePostId, body: "let me in" }),
      ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));

      await db
        .delete(schema.userBlocks)
        .where(eq(schema.userBlocks.blockerUserId, ownerUserId));
    });

    it("TOO_MANY_REQUESTS after 30 comments in 60s (per commenter, across posts)", async () => {
      const [spammer] = await db
        .insert(schema.users)
        .values({ email: "socialspammer@test.invalid", username: "socialspammer", passwordHash: "x" })
        .returning({ id: schema.users.id });
      if (!spammer) throw new Error("Failed to seed spammer");
      seededUserIds.push(spammer.id);

      await db.insert(schema.gardenPostComments).values(
        Array.from({ length: 29 }, (_, i) => ({
          postId: visiblePostId,
          userId: spammer.id,
          body: `spam ${i}`,
        })),
      );

      const spammerCaller = createCaller(ctxFor(spammer.id));
      await expect(
        spammerCaller.garden.createComment({ postId: visiblePostId, body: "comment 30 — still fine" }),
      ).resolves.toMatchObject({ userId: spammer.id });

      await expect(
        spammerCaller.garden.createComment({ postId: visiblePostId, body: "comment 31 — throttled" }),
      ).rejects.toThrow(expect.objectContaining({ code: "TOO_MANY_REQUESTS" }));
    });
  });

  // -------------------------------------------------------------------------
  // listComments
  // -------------------------------------------------------------------------

  describe("listComments", () => {
    it("newest-first keyset pagination across 2 pages, on a fresh post", async () => {
      const [freshPost] = await db
        .insert(schema.gardenPosts)
        .values({
          storeId,
          type: "photo_set",
          status: "ready",
          caption: "Pagination test post",
          photos: [{ url: "https://storage.googleapis.com/bucket/pagination.jpg" }],
        })
        .returning({ id: schema.gardenPosts.id });
      if (!freshPost) throw new Error("Failed to seed fresh post");
      seededPostIds.push(freshPost.id);

      const caller = createCaller(ctxFor(commenterId));
      const c1 = await caller.garden.createComment({ postId: freshPost.id, body: "first" });
      const c2 = await caller.garden.createComment({ postId: freshPost.id, body: "second" });
      const c3 = await caller.garden.createComment({ postId: freshPost.id, body: "third" });

      const page1 = await caller.garden.listComments({ postId: freshPost.id, limit: 2 });
      expect(page1.comments.map((c) => c.id)).toEqual([c3.id, c2.id]);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await caller.garden.listComments({
        postId: freshPost.id,
        limit: 2,
        cursor: page1.nextCursor ?? undefined,
      });
      expect(page2.comments.map((c) => c.id)).toEqual([c1.id]);
      expect(page2.nextCursor).toBeNull();
    });

    it("a soft-deleted comment holds its thread position (deleted:true, body:'')", async () => {
      const [post] = await db
        .insert(schema.gardenPosts)
        .values({
          storeId,
          type: "photo_set",
          status: "ready",
          caption: "Delete-placeholder test post",
          photos: [{ url: "https://storage.googleapis.com/bucket/del.jpg" }],
        })
        .returning({ id: schema.gardenPosts.id });
      if (!post) throw new Error("Failed to seed post");
      seededPostIds.push(post.id);

      const caller = createCaller(ctxFor(commenterId));
      const comment = await caller.garden.createComment({ postId: post.id, body: "oops, deleting this" });
      await caller.garden.deleteComment({ commentId: comment.id });

      const result = await caller.garden.listComments({ postId: post.id });
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]).toMatchObject({ id: comment.id, deleted: true, body: "" });
    });

    it("filters out comments from a deactivated author and from a blocked-either-direction user", async () => {
      const [post] = await db
        .insert(schema.gardenPosts)
        .values({
          storeId,
          type: "photo_set",
          status: "ready",
          caption: "Filter test post",
          photos: [{ url: "https://storage.googleapis.com/bucket/filter.jpg" }],
        })
        .returning({ id: schema.gardenPosts.id });
      if (!post) throw new Error("Failed to seed post");
      seededPostIds.push(post.id);

      // Live comment from the (already-seeded) deactivated user, direct insert
      // (createComment would itself reject a deactivated CALLER — this
      // exercises the READ-side filter instead).
      const [deactivatedComment] = await db
        .insert(schema.gardenPostComments)
        .values({ postId: post.id, userId: deactivatedUserId, body: "from a deactivated account" })
        .returning({ id: schema.gardenPostComments.id });
      if (!deactivatedComment) throw new Error("Failed to seed comment");

      await db.insert(schema.userBlocks).values({
        blockerUserId: otherUserId,
        blockedUserId: commenterId,
      });

      const commenterCaller = createCaller(ctxFor(commenterId));
      await commenterCaller.garden.createComment({ postId: post.id, body: "visible to most" });

      const viewerCaller = createCaller(ctxFor(otherUserId));
      const result = await viewerCaller.garden.listComments({ postId: post.id });

      const bodies = result.comments.map((c) => c.body);
      expect(bodies).not.toContain("from a deactivated account");
      expect(bodies).not.toContain("visible to most");

      // An unauthenticated/unaffiliated viewer sees both (no blocks apply).
      const anonResult = await createCaller(ctxFor(null)).garden.listComments({ postId: post.id });
      expect(anonResult.comments.map((c) => c.body)).toContain("visible to most");
      expect(anonResult.comments.map((c) => c.body)).not.toContain("from a deactivated account");

      await db
        .delete(schema.userBlocks)
        .where(eq(schema.userBlocks.blockerUserId, otherUserId));
    });

    it("NOT_FOUND on a processing (invisible) post", async () => {
      const caller = createCaller(ctxFor(null));
      await expect(caller.garden.listComments({ postId: processingPostId })).rejects.toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // deleteComment
  // -------------------------------------------------------------------------

  describe("deleteComment", () => {
    it("author-only: a non-author gets NOT_FOUND", async () => {
      const authorCaller = createCaller(ctxFor(commenterId));
      const comment = await authorCaller.garden.createComment({
        postId: visiblePostId,
        body: "mine to delete",
      });

      const strangerCaller = createCaller(ctxFor(otherUserId));
      await expect(strangerCaller.garden.deleteComment({ commentId: comment.id })).rejects.toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );

      await expect(authorCaller.garden.deleteComment({ commentId: comment.id })).resolves.toEqual({
        success: true,
      });
    });

    it("is idempotent — deleting an already-deleted comment does not error", async () => {
      const authorCaller = createCaller(ctxFor(commenterId));
      const comment = await authorCaller.garden.createComment({
        postId: visiblePostId,
        body: "delete me twice",
      });

      await expect(authorCaller.garden.deleteComment({ commentId: comment.id })).resolves.toEqual({
        success: true,
      });
      await expect(authorCaller.garden.deleteComment({ commentId: comment.id })).resolves.toEqual({
        success: true,
      });
    });
  });

  // -------------------------------------------------------------------------
  // reportComment
  // -------------------------------------------------------------------------

  describe("reportComment", () => {
    it("happy path succeeds", async () => {
      const authorCaller = createCaller(ctxFor(commenterId));
      const comment = await authorCaller.garden.createComment({
        postId: visiblePostId,
        body: "reportable comment",
      });

      const reporterCaller = createCaller(ctxFor(otherUserId));
      await expect(
        reporterCaller.garden.reportComment({ commentId: comment.id, reason: "spam" }),
      ).resolves.toEqual({ success: true });
    });

    it("NOT_FOUND for a nonexistent comment", async () => {
      const caller = createCaller(ctxFor(otherUserId));
      await expect(
        caller.garden.reportComment({
          commentId: "00000000-0000-0000-0000-000000000000",
          reason: "spam",
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    });

    it("TOO_MANY_REQUESTS after 10 reports in an hour", async () => {
      const authorCaller = createCaller(ctxFor(commenterId));
      const comment = await authorCaller.garden.createComment({
        postId: visiblePostId,
        body: "report throttle target",
      });

      await db.insert(schema.gardenCommentReports).values(
        Array.from({ length: 10 }, () => ({
          commentId: comment.id,
          reporterUserId: otherUserId,
          reason: "spam",
        })),
      );

      const reporterCaller = createCaller(ctxFor(otherUserId));
      await expect(
        reporterCaller.garden.reportComment({ commentId: comment.id, reason: "spam again" }),
      ).rejects.toThrow(expect.objectContaining({ code: "TOO_MANY_REQUESTS" }));
    });
  });
});
