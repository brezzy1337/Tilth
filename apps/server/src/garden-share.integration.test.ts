/**
 * Postgres integration test for `handleGardenShareRequest` (F-053's public
 * `GET /garden/{postId}` share page).
 *
 * GUARDED — only runs when TEST_DATABASE_URL is set (mirrors
 * garden.social.integration.test.ts). To run locally:
 *
 *   docker compose up -d db
 *   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
 *     pnpm --filter @homegrown/server test src/garden-share.integration.test.ts
 *
 * Covers (the DB-backed half of the pure-render split; see
 * garden-share-html.test.ts for OG-tag content / escaping assertions):
 *   - 200 + og tags + escaped caption (XSS attempt) for a visible photo_set post.
 *   - 404 for an unknown postId.
 *   - 404 for an invisible (processing) post.
 *   - 404 for a post owned by a deactivated seller (same predicate as
 *     `garden.feed`/`toggleLike`/comments — `isGardenPostVisible`).
 *   - 404 for a malformed (non-UUID) postId — never hits the DB with a bad param.
 *   - Cache-Control: public, max-age=300 + X-Content-Type-Options: nosniff on
 *     a 200 response; nosniff also on a 404.
 *   - The in-process TTL cache: a 200 and a 404 both serve a second request
 *     for the same postId without touching the DB.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { migrateForTest } from "./db/migrate-for-test";
import * as schema from "./db/schema";
import { handleGardenShareRequest, resetGardenShareCacheForTest } from "./garden-share-html";
import type { Db } from "./context";

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

function fakeReq(method: string): IncomingMessage {
  return { method } as unknown as IncomingMessage;
}

function recordingRes(): ServerResponse & {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  done: Promise<void>;
} {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const rec = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: "",
    done,
    writeHead(status: number, headers?: Record<string, unknown>) {
      rec.statusCode = status;
      rec.headers = headers ?? {};
      return rec;
    },
    end(chunk?: string) {
      rec.body = chunk ?? "";
      resolveDone();
      return rec;
    },
  };
  return rec as unknown as ServerResponse & {
    statusCode: number;
    headers: Record<string, unknown>;
    body: string;
    done: Promise<void>;
  };
}

describeWithDb("handleGardenShareRequest — Postgres integration", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;

  const seededUserIds: string[] = [];
  const seededStoreIds: string[] = [];
  const seededPostIds: string[] = [];

  let visiblePostId: string, processingPostId: string, deactivatedOwnerPostId: string;

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });
    await migrateForTest(client, db);

    const [user] = await db
      .insert(schema.users)
      .values({ email: "shareowner@test.invalid", username: "shareowner", passwordHash: "x" })
      .returning({ id: schema.users.id });
    if (!user) throw new Error("Failed to seed user");
    seededUserIds.push(user.id);

    const [deactivatedUser] = await db
      .insert(schema.users)
      .values({
        email: "sharedeactivatedowner@test.invalid",
        username: "sharedeactivatedowner",
        passwordHash: "x",
        deactivatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    if (!deactivatedUser) throw new Error("Failed to seed deactivated user");
    seededUserIds.push(deactivatedUser.id);

    const [store] = await db
      .insert(schema.stores)
      .values({ userId: user.id, name: "Share Test Farm" })
      .returning({ id: schema.stores.id });
    if (!store) throw new Error("Failed to seed store");
    seededStoreIds.push(store.id);

    const [deactivatedOwnerStore] = await db
      .insert(schema.stores)
      .values({ userId: deactivatedUser.id, name: "Deactivated Owner Farm" })
      .returning({ id: schema.stores.id });
    if (!deactivatedOwnerStore) throw new Error("Failed to seed deactivated-owner store");
    seededStoreIds.push(deactivatedOwnerStore.id);

    const [visiblePost] = await db
      .insert(schema.gardenPosts)
      .values({
        storeId: store.id,
        type: "photo_set",
        status: "ready",
        caption: `<script>alert('xss')</script> fresh kale!`,
        photos: [{ url: "https://storage.googleapis.com/bucket/kale.jpg" }],
      })
      .returning({ id: schema.gardenPosts.id });
    const [processingPost] = await db
      .insert(schema.gardenPosts)
      .values({ storeId: store.id, type: "video", status: "processing", caption: "not ready" })
      .returning({ id: schema.gardenPosts.id });
    const [deactivatedOwnerPost] = await db
      .insert(schema.gardenPosts)
      .values({
        storeId: deactivatedOwnerStore.id,
        type: "photo_set",
        status: "ready",
        caption: "should be hidden — owner deactivated",
        photos: [{ url: "https://storage.googleapis.com/bucket/hidden.jpg" }],
      })
      .returning({ id: schema.gardenPosts.id });
    if (!visiblePost || !processingPost || !deactivatedOwnerPost) {
      throw new Error("Failed to seed posts");
    }
    visiblePostId = visiblePost.id;
    processingPostId = processingPost.id;
    deactivatedOwnerPostId = deactivatedOwnerPost.id;
    seededPostIds.push(visiblePostId, processingPostId, deactivatedOwnerPostId);
  });

  beforeEach(() => {
    // The share page's TTL cache is a module-level singleton — reset it
    // before each test so a cached result from one test can't leak into
    // another (each test below still uses a distinct postId, but this keeps
    // that an invariant rather than an accident).
    resetGardenShareCacheForTest();
  });

  afterAll(async () => {
    for (const id of seededPostIds) {
      await db.delete(schema.gardenPosts).where(eq(schema.gardenPosts.id, id));
    }
    for (const id of seededStoreIds) {
      await db.delete(schema.stores).where(eq(schema.stores.id, id));
    }
    for (const id of seededUserIds) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await client.end();
  });

  it("200s a visible post with OG tags, the escaped (XSS-safe) caption, and a 5-minute Cache-Control", async () => {
    const res = recordingRes();
    handleGardenShareRequest(fakeReq("GET"), res, { db: db as unknown as Db, postId: visiblePostId });
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["Cache-Control"]).toBe("public, max-age=300");
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(res.body).toContain("Share Test Farm on Tilth");
    expect(res.body).toContain('<meta property="og:title" content="Share Test Farm on Tilth" />');
    expect(res.body).toContain(
      '<meta property="og:image" content="https://storage.googleapis.com/bucket/kale.jpg" />',
    );
    expect(res.body).not.toContain("<script>alert");
    expect(res.body).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
  });

  it("404s an unknown postId", async () => {
    const res = recordingRes();
    handleGardenShareRequest(fakeReq("GET"), res, {
      db: db as unknown as Db,
      postId: "00000000-0000-0000-0000-000000000000",
    });
    await res.done;

    expect(res.statusCode).toBe(404);
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(res.body).toContain("Post not found");
  });

  it("404s a processing (invisible) post", async () => {
    const res = recordingRes();
    handleGardenShareRequest(fakeReq("GET"), res, { db: db as unknown as Db, postId: processingPostId });
    await res.done;

    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Post not found");
  });

  it("404s a post owned by a deactivated seller (same predicate as garden.feed/toggleLike/comments)", async () => {
    const res = recordingRes();
    handleGardenShareRequest(fakeReq("GET"), res, {
      db: db as unknown as Db,
      postId: deactivatedOwnerPostId,
    });
    await res.done;

    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Post not found");
  });

  it("caches a 200 response for the TTL, serving a repeat request without touching the DB", async () => {
    const first = recordingRes();
    handleGardenShareRequest(fakeReq("GET"), first, { db: db as unknown as Db, postId: visiblePostId });
    await first.done;
    expect(first.statusCode).toBe(200);

    let dbTouched = false;
    const proxyDb = new Proxy(
      {},
      {
        get() {
          dbTouched = true;
          throw new Error("should not be called");
        },
      },
    ) as unknown as Db;

    const second = recordingRes();
    handleGardenShareRequest(fakeReq("GET"), second, { db: proxyDb, postId: visiblePostId });
    await second.done;

    expect(dbTouched).toBe(false);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
  });

  it("negative-caches a 404 (unknown postId), serving a repeat request without touching the DB", async () => {
    const missingId = "11111111-1111-1111-1111-111111111111";

    const first = recordingRes();
    handleGardenShareRequest(fakeReq("GET"), first, { db: db as unknown as Db, postId: missingId });
    await first.done;
    expect(first.statusCode).toBe(404);

    let dbTouched = false;
    const proxyDb = new Proxy(
      {},
      {
        get() {
          dbTouched = true;
          throw new Error("should not be called");
        },
      },
    ) as unknown as Db;

    const second = recordingRes();
    handleGardenShareRequest(fakeReq("GET"), second, { db: proxyDb, postId: missingId });
    await second.done;

    expect(dbTouched).toBe(false);
    expect(second.statusCode).toBe(404);
  });

  it("404s a malformed (non-UUID) postId without querying the DB", async () => {
    let dbTouched = false;
    const proxyDb = new Proxy(
      {},
      {
        get() {
          dbTouched = true;
          throw new Error("should not be called");
        },
      },
    ) as unknown as Db;

    const res = recordingRes();
    handleGardenShareRequest(fakeReq("GET"), res, { db: proxyDb, postId: "not-a-uuid" });
    await res.done;

    expect(dbTouched).toBe(false);
    expect(res.statusCode).toBe(404);
  });
});
