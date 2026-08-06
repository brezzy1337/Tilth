import { describe, it, expect } from "vitest";
import {
  RESTORE_CODE_LENGTH,
  RESTORE_CODE_TTL_MINUTES,
  RESTORE_CODE_MAX_ATTEMPTS,
  RESTORE_CODE_RESEND_COOLDOWN_SECONDS,
  RESTORE_CODE_MAX_PER_HOUR,
  RESTORE_VERIFICATION_REQUIRED,
  restoreCodeSchema,
  requestRestoreCodeInput,
  verifyRestoreInput,
  requestRestoreCodeOutput,
  otpPurpose,
  loginInput,
} from "./index.js";

describe("restoreCodeSchema", () => {
  it("accepts a valid 6-digit code", () => {
    expect(restoreCodeSchema.safeParse("042137").success).toBe(true);
  });

  it("rejects a 5-digit code", () => {
    expect(restoreCodeSchema.safeParse("04213").success).toBe(false);
  });

  it("rejects a 7-digit code", () => {
    expect(restoreCodeSchema.safeParse("0421378").success).toBe(false);
  });

  it("rejects letters", () => {
    expect(restoreCodeSchema.safeParse("04a137").success).toBe(false);
  });

  it("rejects a code containing spaces", () => {
    expect(restoreCodeSchema.safeParse("042 37").success).toBe(false);
  });
});

describe("requestRestoreCodeInput schema", () => {
  it("mirrors loginInput's field rules: a value valid for loginInput is valid here", () => {
    const value = { usernameOrEmail: "sunny_acres", password: "x" };
    expect(loginInput.safeParse(value).success).toBe(true);
    expect(requestRestoreCodeInput.safeParse(value).success).toBe(true);
  });

  it("rejects an empty usernameOrEmail, same as loginInput", () => {
    const value = { usernameOrEmail: "", password: "x" };
    expect(loginInput.safeParse(value).success).toBe(false);
    expect(requestRestoreCodeInput.safeParse(value).success).toBe(false);
  });

  it("rejects an empty password, same as loginInput", () => {
    const value = { usernameOrEmail: "sunny_acres", password: "" };
    expect(loginInput.safeParse(value).success).toBe(false);
    expect(requestRestoreCodeInput.safeParse(value).success).toBe(false);
  });
});

describe("verifyRestoreInput schema", () => {
  it("round-trips a valid input", () => {
    const value = { usernameOrEmail: "sunny_acres", password: "x", code: "042137" };
    const result = verifyRestoreInput.safeParse(value);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(value);
    }
  });

  it("rejects when the code is not 6 digits", () => {
    const value = { usernameOrEmail: "sunny_acres", password: "x", code: "42137" };
    expect(verifyRestoreInput.safeParse(value).success).toBe(false);
  });

  it("rejects when the credential fields are invalid, same as requestRestoreCodeInput", () => {
    const value = { usernameOrEmail: "", password: "x", code: "042137" };
    expect(verifyRestoreInput.safeParse(value).success).toBe(false);
  });
});

describe("requestRestoreCodeOutput schema", () => {
  it("parses a valid output", () => {
    const result = requestRestoreCodeOutput.safeParse({
      sent: true,
      maskedEmail: "j***@e***.com",
    });
    expect(result.success).toBe(true);
  });

  it("rejects sent: false", () => {
    const result = requestRestoreCodeOutput.safeParse({
      sent: false,
      maskedEmail: "j***@e***.com",
    });
    expect(result.success).toBe(false);
  });
});

describe("otpPurpose enum", () => {
  it("accepts 'account_restore'", () => {
    expect(otpPurpose.safeParse("account_restore").success).toBe(true);
  });

  it("rejects an unknown purpose", () => {
    expect(otpPurpose.safeParse("password_reset").success).toBe(false);
  });
});

describe("restore verification constants", () => {
  it("codes are 6 digits", () => {
    expect(RESTORE_CODE_LENGTH).toBe(6);
  });

  it("codes are valid for 10 minutes", () => {
    expect(RESTORE_CODE_TTL_MINUTES).toBe(10);
  });

  it("allows 5 incorrect attempts", () => {
    expect(RESTORE_CODE_MAX_ATTEMPTS).toBe(5);
  });

  it("enforces a 60-second resend cooldown", () => {
    expect(RESTORE_CODE_RESEND_COOLDOWN_SECONDS).toBe(60);
  });

  it("caps requests at 5 per hour", () => {
    expect(RESTORE_CODE_MAX_PER_HOUR).toBe(5);
  });

  it("exposes the marker the mobile client matches on", () => {
    expect(RESTORE_VERIFICATION_REQUIRED).toBe("RESTORE_VERIFICATION_REQUIRED");
  });
});
