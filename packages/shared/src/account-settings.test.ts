import { describe, it, expect } from "vitest";
import {
  passwordSchema,
  registerInput,
  loginInput,
  changePasswordInput,
  deleteAccountInput,
  deleteAccountOutput,
  blockedUser,
  listBlockedOutput,
  unblockUserInput,
  unregisterPushTokenInput,
} from "./index.js";

const uuid1 = "11111111-1111-4111-8111-111111111111";

describe("passwordSchema", () => {
  it("accepts a password at the 8-character minimum", () => {
    expect(passwordSchema.safeParse("12345678").success).toBe(true);
  });

  it("rejects a password under the 8-character minimum", () => {
    expect(passwordSchema.safeParse("1234567").success).toBe(false);
  });

  it("accepts a password at the 100-character maximum", () => {
    expect(passwordSchema.safeParse("x".repeat(100)).success).toBe(true);
  });

  it("rejects a password over the 100-character maximum", () => {
    expect(passwordSchema.safeParse("x".repeat(101)).success).toBe(false);
  });
});

describe("registerInput / loginInput are unchanged by the passwordSchema extraction", () => {
  it("registerInput still parses a valid registration", () => {
    const result = registerInput.safeParse({
      email: "grower@example.com",
      username: "sunny_acres",
      password: "password123",
    });
    expect(result.success).toBe(true);
  });

  it("registerInput still rejects a password under 8 characters", () => {
    const result = registerInput.safeParse({
      email: "grower@example.com",
      username: "sunny_acres",
      password: "short1",
    });
    expect(result.success).toBe(false);
  });

  it("registerInput still rejects a password over 100 characters", () => {
    const result = registerInput.safeParse({
      email: "grower@example.com",
      username: "sunny_acres",
      password: "x".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it("loginInput is untouched: still accepts a 1-character password", () => {
    const result = loginInput.safeParse({ usernameOrEmail: "sunny_acres", password: "x" });
    expect(result.success).toBe(true);
  });
});

describe("changePasswordInput schema", () => {
  const valid = { currentPassword: "oldpassword1", newPassword: "newpassword1" };

  it("parses a valid input", () => {
    expect(changePasswordInput.safeParse(valid).success).toBe(true);
  });

  it("rejects a currentPassword under the 8-character minimum", () => {
    const result = changePasswordInput.safeParse({ ...valid, currentPassword: "short1" });
    expect(result.success).toBe(false);
  });

  it("rejects a newPassword under the 8-character minimum", () => {
    const result = changePasswordInput.safeParse({ ...valid, newPassword: "short1" });
    expect(result.success).toBe(false);
  });

  it("rejects a newPassword over the 100-character maximum", () => {
    const result = changePasswordInput.safeParse({ ...valid, newPassword: "x".repeat(101) });
    expect(result.success).toBe(false);
  });
});

describe("deleteAccountInput schema", () => {
  it("parses a valid input", () => {
    expect(deleteAccountInput.safeParse({ password: "currentpass1" }).success).toBe(true);
  });

  it("rejects a password under the 8-character minimum", () => {
    const result = deleteAccountInput.safeParse({ password: "short1" });
    expect(result.success).toBe(false);
  });
});

describe("deleteAccountOutput schema", () => {
  it("parses a valid ISO datetime and round-trips it unchanged", () => {
    const deleteAfter = "2026-08-11T12:00:00.000Z";
    const result = deleteAccountOutput.safeParse({ deleteAfter });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deleteAfter).toBe(deleteAfter);
    }
  });

  it("rejects a date-only string (no time component)", () => {
    const result = deleteAccountOutput.safeParse({ deleteAfter: "2026-08-11" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-datetime string", () => {
    const result = deleteAccountOutput.safeParse({ deleteAfter: "not-a-date" });
    expect(result.success).toBe(false);
  });
});

describe("blockedUser / listBlockedOutput schemas", () => {
  const item = {
    userId: uuid1,
    username: "nosy_neighbor",
    blockedAt: "2026-07-01T09:00:00.000Z",
  };

  it("parses a valid blocked user", () => {
    expect(blockedUser.safeParse(item).success).toBe(true);
  });

  it("rejects a non-uuid userId", () => {
    const result = blockedUser.safeParse({ ...item, userId: "nope" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-datetime blockedAt", () => {
    const result = blockedUser.safeParse({ ...item, blockedAt: "2026-07-01" });
    expect(result.success).toBe(false);
  });

  it("parses an empty listBlockedOutput array", () => {
    expect(listBlockedOutput.safeParse([]).success).toBe(true);
  });

  it("accepts exactly 200 blocked users", () => {
    const result = listBlockedOutput.safeParse(Array(200).fill(item));
    expect(result.success).toBe(true);
  });

  it("rejects more than 200 blocked users", () => {
    const result = listBlockedOutput.safeParse(Array(201).fill(item));
    expect(result.success).toBe(false);
  });
});

describe("unblockUserInput schema", () => {
  it("parses a valid input", () => {
    expect(unblockUserInput.safeParse({ userId: uuid1 }).success).toBe(true);
  });

  it("rejects a non-uuid userId", () => {
    const result = unblockUserInput.safeParse({ userId: "nope" });
    expect(result.success).toBe(false);
  });
});

describe("unregisterPushTokenInput schema", () => {
  it("parses a valid token with no platform field", () => {
    const result = unregisterPushTokenInput.safeParse({ token: "ExponentPushToken[abc123]" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty token", () => {
    const result = unregisterPushTokenInput.safeParse({ token: "" });
    expect(result.success).toBe(false);
  });

  it("accepts a token at the 200-character maximum", () => {
    const result = unregisterPushTokenInput.safeParse({ token: "x".repeat(200) });
    expect(result.success).toBe(true);
  });

  it("rejects a token over the 200-character maximum", () => {
    const result = unregisterPushTokenInput.safeParse({ token: "x".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("ignores a platform field if present (not part of the schema, but not rejected)", () => {
    const result = unregisterPushTokenInput.safeParse({
      token: "ExponentPushToken[abc123]",
      platform: "ios",
    });
    expect(result.success).toBe(true);
  });
});
