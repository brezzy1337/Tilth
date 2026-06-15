/**
 * Unit tests for auth helpers (auth.ts).
 *
 * No DB, no env — all functions take parameters.
 */

import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
} from "./auth";

const TEST_SECRET = "test-jwt-secret-that-is-at-least-32-chars";

describe("hashPassword / verifyPassword", () => {
  it("round-trips: verify returns true for the same password", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(await verifyPassword("correct-horse-battery", hash)).toBe(true);
  });

  it("returns false for the wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("produces different hashes for the same password (random salt)", async () => {
    const h1 = await hashPassword("same-password");
    const h2 = await hashPassword("same-password");
    expect(h1).not.toBe(h2);
    // But both must verify correctly
    expect(await verifyPassword("same-password", h1)).toBe(true);
    expect(await verifyPassword("same-password", h2)).toBe(true);
  });

  it("returns false for a malformed stored hash", async () => {
    expect(await verifyPassword("any-password", "no-colon-here")).toBe(false);
  });

  it("returns false when password is empty string", async () => {
    const hash = await hashPassword("real-password");
    expect(await verifyPassword("", hash)).toBe(false);
  });
});

describe("signToken / verifyToken", () => {
  it("round-trips: verify returns the userId that was signed", async () => {
    const userId = "123e4567-e89b-12d3-a456-426614174000";
    const token = await signToken(userId, TEST_SECRET);
    const result = await verifyToken(token, TEST_SECRET);
    expect(result).toBe(userId);
  });

  it("returns null for a tampered token", async () => {
    const token = await signToken("user-id", TEST_SECRET);
    // Replace the signature (3rd segment) entirely with garbage base64url
    const parts = token.split(".");
    // Overwrite the payload sub with a different value to make the signature wrong
    parts[2] = "aGFja2VkdGhpcw";
    const tamperedToken = parts.join(".");
    expect(await verifyToken(tamperedToken, TEST_SECRET)).toBeNull();
  });

  it("returns null for a token signed with a different secret", async () => {
    const token = await signToken("user-id", TEST_SECRET);
    const result = await verifyToken(token, "completely-different-secret-key-xyz");
    expect(result).toBeNull();
  });

  it("returns null for a completely invalid string", async () => {
    expect(await verifyToken("not.a.jwt", TEST_SECRET)).toBeNull();
  });

  it("returns null for an empty string", async () => {
    expect(await verifyToken("", TEST_SECRET)).toBeNull();
  });
});
