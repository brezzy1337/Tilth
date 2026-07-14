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
 *   - 404 for a malformed (non-UUID) postId — never hits the DB with a bad param.
 *   - Cache-Control: public, max-age=300 on a 200 response.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { migrateForTest } from "./db/migrate-for-test";
import * as schema from "./db/schema";
import { handleGardenShareRequest } from "./garden-share-html";
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

  let visiblePostId: string, processingPostId: string;

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

    const [store] = await db
      .insert(schema.stores)
      .values({ userId: user.id, name: "Share Test Farm" })
      .returning({ id: schema.stores.id });
    if (!store) throw new Error("Failed to seed store");
    seededStoreIds.push(store.id);

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
    if (!visiblePost || !processingPost) throw new Error("Failed to seed posts");
    visiblePostId = visiblePost.id;
    processingPostId = processingPost.id;
    seededPostIds.push(visiblePostId, processingPostId);
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
    expect(res.body).toContain("Post not found");
  });

  it("404s a processing (invisible) post", async () => {
    const res = recordingRes();
    handleGardenShareRequest(fakeReq("GET"), res, { db: db as unknown as Db, postId: processingPostId });
    await res.done;

    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("Post not found");
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
