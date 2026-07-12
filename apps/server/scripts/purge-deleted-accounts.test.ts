/**
 * Unit tests for the pure anonymization transforms in the purge-deleted-
 * accounts CLI (F-051). `anonymizedEmail` / `anonymizedUsername` are pure —
 * no DB, no network. Importing this module never triggers the CLI (guarded
 * by the `isMainModule` check at the bottom of that file) or a DB connection
 * (the drizzle client is created lazily inside `getDb`, only reached from
 * the command handlers, which these unit tests never call).
 *
 * Full purge behavior (DB writes: users/store/push_tokens/user_blocks) is
 * covered by auth.account-settings.integration.test.ts against a real
 * Postgres instance — too DB-heavy to usefully fake here.
 */

import { describe, it, expect } from "vitest";
import { anonymizedEmail, anonymizedUsername, DELETED_STORE_NAME } from "./purge-deleted-accounts";

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
