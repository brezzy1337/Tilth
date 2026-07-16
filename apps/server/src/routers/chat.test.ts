/**
 * Unit tests for pure/small helpers in the chat router (F-037/F-038).
 *
 * No real DB — helpers.ts's `isBlockedEitherDirection` (shared with
 * sourcing.ts and garden.ts) is exercised here against a minimal fake
 * select() builder (mirrors the fakeGardenDb pattern in garden.test.ts).
 *
 * Full router behavior (start/list/messages/send/markRead/blockUser/
 * reportMessage/registerPushToken, including participant authz, unread
 * counts, and pagination) is covered by chat.integration.test.ts against a
 * real Postgres instance — those flows are too join/transaction-heavy to
 * usefully fake here.
 *
 * Covers:
 *   - encodeMessagesCursor / decodeMessagesCursor round-trip + malformed inputs.
 *   - encodeConversationsCursor / decodeConversationsCursor round-trip
 *     (including the null-lastMessageAt sentinel) + malformed inputs.
 *   - truncate: no-op under the limit, truncates + appends an ellipsis over it.
 *   - isBlockedEitherDirection: true when a blocks b, true when b blocks a,
 *     false when neither blocks the other.
 *   - assertSendRateLimit: passes under the 30-message window, throws
 *     TOO_MANY_REQUESTS at/over it (DB count faked; the real count query is
 *     exercised in chat.integration.test.ts).
 */

import { describe, it, expect } from "vitest";
import {
  encodeMessagesCursor,
  decodeMessagesCursor,
  encodeConversationsCursor,
  decodeConversationsCursor,
  truncate,
  assertSendRateLimit,
} from "./chat";
import { isBlockedEitherDirection } from "./helpers";
import type { Db } from "../context";

const UUID_A = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const UUID_B = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const T0 = new Date("2026-01-01T00:00:00.000Z");

describe("chat — messages cursor codec", () => {
  it("round-trips (createdAt, id)", () => {
    const cursor = encodeMessagesCursor(T0, UUID_A);
    const decoded = decodeMessagesCursor(cursor);
    expect(decoded.createdAt.toISOString()).toBe(T0.toISOString());
    expect(decoded.id).toBe(UUID_A);
  });

  it("throws BAD_REQUEST on a cursor missing the '|' separator", () => {
    expect(() => decodeMessagesCursor(btoa("no-separator-here"))).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });

  it("throws BAD_REQUEST on invalid base64", () => {
    expect(() => decodeMessagesCursor("!!!not-base64!!!")).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });

  it("throws BAD_REQUEST when the id segment isn't a UUID", () => {
    expect(() => decodeMessagesCursor(btoa(`${T0.toISOString()}|not-a-uuid`))).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });

  it("throws BAD_REQUEST when the date segment is unparsable", () => {
    expect(() => decodeMessagesCursor(btoa(`not-a-date|${UUID_A}`))).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });
});

describe("chat — conversations cursor codec (nullable lastMessageAt)", () => {
  it("round-trips a non-null lastMessageAt", () => {
    const cursor = encodeConversationsCursor(T0, UUID_A);
    const decoded = decodeConversationsCursor(cursor);
    expect(decoded.lastMessageAt?.toISOString()).toBe(T0.toISOString());
    expect(decoded.id).toBe(UUID_A);
  });

  it("round-trips a null lastMessageAt via the empty-string sentinel", () => {
    const cursor = encodeConversationsCursor(null, UUID_B);
    const decoded = decodeConversationsCursor(cursor);
    expect(decoded.lastMessageAt).toBeNull();
    expect(decoded.id).toBe(UUID_B);
  });

  it("throws BAD_REQUEST on a cursor missing the '|' separator", () => {
    expect(() => decodeConversationsCursor(btoa("no-separator-here"))).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });

  it("throws BAD_REQUEST when the id segment isn't a UUID", () => {
    expect(() => decodeConversationsCursor(btoa("|not-a-uuid"))).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });
});

describe("chat — truncate", () => {
  it("returns the text unchanged when at or under the limit", () => {
    expect(truncate("hello", 120)).toBe("hello");
    expect(truncate("x".repeat(120), 120)).toBe("x".repeat(120));
  });

  it("truncates and appends an ellipsis when over the limit", () => {
    const long = "x".repeat(150);
    const result = truncate(long, 120);
    expect(result).toBe(`${"x".repeat(120)}…`);
    expect(result.length).toBe(121);
  });
});

describe("chat — isBlockedEitherDirection", () => {
  function fakeDb(blockRows: Array<{ blockerUserId: string }>): Db {
    const selectBuilder = {
      from: () => selectBuilder,
      where: () => selectBuilder,
      limit: () => Promise.resolve(blockRows),
    };
    return { select: () => selectBuilder } as unknown as Db;
  }

  it("returns true when a query for either direction finds a row", async () => {
    const db = fakeDb([{ blockerUserId: UUID_A }]);
    await expect(isBlockedEitherDirection(db, UUID_A, UUID_B)).resolves.toBe(true);
  });

  it("returns false when no block row exists", async () => {
    const db = fakeDb([]);
    await expect(isBlockedEitherDirection(db, UUID_A, UUID_B)).resolves.toBe(false);
  });
});

describe("chat — assertSendRateLimit", () => {
  /** Fake the `select({ count }).from(messages).where(...)` count query. */
  function fakeCountDb(recentCount: number): Db {
    const selectBuilder = {
      from: () => selectBuilder,
      where: () => Promise.resolve([{ count: recentCount }]),
    };
    return { select: () => selectBuilder } as unknown as Db;
  }

  it("resolves when the sender is under the window (29 recent messages)", async () => {
    await expect(assertSendRateLimit(fakeCountDb(29), UUID_A)).resolves.toBeUndefined();
  });

  it("throws TOO_MANY_REQUESTS at the limit (30 recent messages)", async () => {
    await expect(assertSendRateLimit(fakeCountDb(30), UUID_A)).rejects.toThrow(
      expect.objectContaining({ code: "TOO_MANY_REQUESTS" }),
    );
  });

  it("throws TOO_MANY_REQUESTS over the limit", async () => {
    await expect(assertSendRateLimit(fakeCountDb(45), UUID_A)).rejects.toThrow(
      expect.objectContaining({ code: "TOO_MANY_REQUESTS" }),
    );
  });
});
