/**
 * Tests for the purge-deleted-accounts CLI (F-051).
 *
 * `anonymizedEmail` / `anonymizedUsername` / `maskEmail` are pure — no DB, no
 * network — and are always exercised. Importing this module never triggers
 * the CLI itself (guarded by the `isMainModule` check at the bottom of that
 * file) or a DB connection (the drizzle client is created lazily inside
 * `lib.ts`'s `getDb`, only reached from the command handlers / `purgeOneUser`,
 * which the pure-transform tests below never call).
 *
 * `purgeOneUser`'s actual DB-write behavior (users scrub, push_tokens delete,
 * user_blocks delete both directions, store rename) is covered by the
 * Postgres-integration `describe` block further down — GUARDED on
 * TEST_DATABASE_URL, same pattern as auth.account-settings.integration.test.ts
 * (which does NOT cover this CLI; it only covers `auth.deleteAccount`, the
 * router mutation this CLI's second stage runs after).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, or } from "drizzle-orm";
import { migrateForTest } from "../src/db/migrate-for-test";
import * as schema from "../src/db/schema";
import {
  anonymizedEmail,
  anonymizedUsername,
  maskEmail,
  DELETED_STORE_NAME,
  purgeOneUser,
} from "./purge-deleted-accounts";

describe("anonymizedEmail", () => {
  it("is deterministic on the user id", () => {
    const id = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    expect(anonymizedEmail(id)).toBe(`deleted-${id}@deleted.invalid`);
    expect(anonymizedEmail(id)).toBe(anonymizedEmail(id));
  });

  it("differs for different user ids", () => {
    expect(anonymizedEmail("id-a")).not.toBe(anonymizedEmail("id-b"));
  });
});

describe("anonymizedUsername", () => {
  it("prefixes the supplied random suffix with 'deleted-'", () => {
    expect(anonymizedUsername("abcd1234")).toBe("deleted-abcd1234");
  });

  it("is deterministic given the same suffix", () => {
    expect(anonymizedUsername("ffffffff")).toBe(anonymizedUsername("ffffffff"));
  });
});

describe("DELETED_STORE_NAME", () => {
  it("is a stable, non-PII placeholder", () => {
    expect(DELETED_STORE_NAME).toBe("Deleted stand");
  });
});

describe("maskEmail", () => {
  it("keeps the first char of the local part and the first char of the domain head, masks the rest", () => {
    expect(maskEmail("jane@example.com")).toBe("j***@e***.com");
  });

  it("keeps a multi-part TLD's leading dot segment as the 'domain head'", () => {
    expect(maskEmail("a@b.co.uk")).toBe("a***@b***.uk");
  });

  it("never throws on a malformed (no '@') value — returns a fixed redacted placeholder", () => {
    expect(maskEmail("not-an-email")).toBe("***");
  });
});

// ---------------------------------------------------------------------------
// purgeOneUser — Postgres integration.
//
// GUARDED — only runs when TEST_DATABASE_URL is set (mirrors
// auth.account-settings.integration.test.ts). To run locally:
//
//   docker compose up -d db
//   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
//     pnpm --filter @homegrown/server test scripts/purge-deleted-accounts.test.ts
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("purgeOneUser — Postgres integration", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;

  const seededUserIds: string[] = [];
  const seededStoreIds: string[] = [];

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });
    await migrateForTest(client, db);
  });

  afterAll(async () => {
    if (seededStoreIds.length > 0) {
      await db
        .delete(schema.stores)
        .where(or(...seededStoreIds.map((id) => eq(schema.stores.id, id))));
    }
    if (seededUserIds.length > 0) {
      await db
        .delete(schema.users)
        .where(or(...seededUserIds.map((id) => eq(schema.users.id, id))));
    }
    await client.end();
  });

  it("scrubs email/username/passwordHash/stripeCustomerId, deletes push_tokens + user_blocks (both directions), renames the store, and leaves deactivatedAt/deleteAfter set", async () => {
    const pastGrace = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [purgeTarget] = await db
      .insert(schema.users)
      .values({
        email: "purge-target@test.invalid",
        username: "purgetarget",
        passwordHash: "original-hash",
        stripeCustomerId: "cus_original",
        deactivatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        deleteAfter: pastGrace,
      })
      .returning({ id: schema.users.id });
    if (!purgeTarget) throw new Error("Failed to seed purge target");
    seededUserIds.push(purgeTarget.id);

    const [otherUser] = await db
      .insert(schema.users)
      .values({ email: "purge-other@test.invalid", username: "purgeother", passwordHash: "x" })
      .returning({ id: schema.users.id });
    if (!otherUser) throw new Error("Failed to seed other user");
    seededUserIds.push(otherUser.id);

    const [store] = await db
      .insert(schema.stores)
      .values({
        userId: purgeTarget.id,
        name: "Purge Target's Real Farm Name",
        logo: "https://example.com/logo.png",
        about: "Some real about text",
      })
      .returning({ id: schema.stores.id });
    if (!store) throw new Error("Failed to seed store");
    seededStoreIds.push(store.id);

    await db.insert(schema.pushTokens).values({
      userId: purgeTarget.id,
      token: "ExponentPushToken[purge-target]",
      platform: "ios",
    });

    // Both directions of user_blocks — purgeTarget as blocker, and as blocked.
    await db.insert(schema.userBlocks).values([
      { blockerUserId: purgeTarget.id, blockedUserId: otherUser.id },
      { blockerUserId: otherUser.id, blockedUserId: purgeTarget.id },
    ]);

    const result = await purgeOneUser(db, purgeTarget.id);
    expect(result).toEqual({ hadStore: true });

    const [userRow] = await db
      .select({
        email: schema.users.email,
        username: schema.users.username,
        passwordHash: schema.users.passwordHash,
        stripeCustomerId: schema.users.stripeCustomerId,
        deactivatedAt: schema.users.deactivatedAt,
        deleteAfter: schema.users.deleteAfter,
      })
      .from(schema.users)
      .where(eq(schema.users.id, purgeTarget.id))
      .limit(1);

    expect(userRow?.email).toBe(anonymizedEmail(purgeTarget.id));
    expect(userRow?.username).toMatch(/^deleted-[0-9a-f]{8}$/);
    expect(userRow?.passwordHash).not.toBe("original-hash");
    expect(userRow?.stripeCustomerId).toBeNull();
    // deactivatedAt/deleteAfter are left SET — purge never clears them.
    expect(userRow?.deactivatedAt).not.toBeNull();
    expect(userRow?.deleteAfter).not.toBeNull();

    const tokens = await db
      .select()
      .from(schema.pushTokens)
      .where(eq(schema.pushTokens.userId, purgeTarget.id));
    expect(tokens).toHaveLength(0);

    const blocksAsBlocker = await db
      .select()
      .from(schema.userBlocks)
      .where(eq(schema.userBlocks.blockerUserId, purgeTarget.id));
    expect(blocksAsBlocker).toHaveLength(0);

    const blocksAsBlocked = await db
      .select()
      .from(schema.userBlocks)
      .where(eq(schema.userBlocks.blockedUserId, purgeTarget.id));
    expect(blocksAsBlocked).toHaveLength(0);

    const [storeRow] = await db
      .select({ name: schema.stores.name, logo: schema.stores.logo, about: schema.stores.about })
      .from(schema.stores)
      .where(eq(schema.stores.id, store.id))
      .limit(1);
    expect(storeRow?.name).toBe(DELETED_STORE_NAME);
    expect(storeRow?.logo).toBeNull();
    expect(storeRow?.about).toBeNull();
  });

  it("hadStore: false when the purged user has no store", async () => {
    const [noStoreUser] = await db
      .insert(schema.users)
      .values({
        email: "purge-no-store@test.invalid",
        username: "purgenostore",
        passwordHash: "x",
        deactivatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        deleteAfter: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
      .returning({ id: schema.users.id });
    if (!noStoreUser) throw new Error("Failed to seed user");
    seededUserIds.push(noStoreUser.id);

    const result = await purgeOneUser(db, noStoreUser.id);
    expect(result).toEqual({ hadStore: false });
  });
});
