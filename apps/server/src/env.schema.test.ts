import { describe, expect, it } from "vitest";
import { envSchema } from "./env.schema.js";

// ---------------------------------------------------------------------------
// DATABASE_URL — unix-socket vs TCP acceptance
// ---------------------------------------------------------------------------

describe("envSchema DATABASE_URL", () => {
  const baseEnv = {
    JWT_SECRET: "a-very-long-secret-that-is-at-least-32-chars!!",
    GOOGLE_GEOCODING_API_KEY: "geocode-key",
    STRIPE_SECRET_KEY: "sk_test_abc123",
    STRIPE_WEBHOOK_SECRET: "whsec_abc123",
    STRIPE_WEBHOOK_SECRET_CONNECT: "whsec_connect_abc123",
  };

  it("accepts the Cloud SQL unix-socket form (empty host)", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      DATABASE_URL:
        "postgres://u:p@/homegrown?host=/cloudsql/proj:us-central1:inst",
    });
    expect(result.success).toBe(true);
  });

  it("accepts the TCP form", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      DATABASE_URL: "postgres://u:p@127.0.0.1:5432/homegrown",
    });
    expect(result.success).toBe(true);
  });

  it("accepts the postgresql:// scheme variant", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      DATABASE_URL: "postgresql://u:p@localhost:5432/homegrown",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-postgres string", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      DATABASE_URL: "not-a-db",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toContain("DATABASE_URL");
  });

  it("rejects an empty string", () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      DATABASE_URL: "",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toContain("DATABASE_URL");
  });
});

// ---------------------------------------------------------------------------
// Full happy-path parse with a socket-form DATABASE_URL
// ---------------------------------------------------------------------------

describe("envSchema full happy-path", () => {
  it("parses a complete valid environment with unix-socket DATABASE_URL", () => {
    const result = envSchema.safeParse({
      PORT: "8080",
      NODE_ENV: "production",
      DATABASE_URL:
        "postgres://appuser:s3cr3t@/homegrown?host=/cloudsql/my-proj:us-central1:my-inst",
      JWT_SECRET: "super-secret-jwt-key-that-is-at-least-32-chars",
      GOOGLE_GEOCODING_API_KEY: "AIzaSyFakeKey",
      STRIPE_SECRET_KEY: "sk_test_51FakeStripeKey",
      STRIPE_WEBHOOK_SECRET: "whsec_fakeWebhookSecret",
      STRIPE_WEBHOOK_SECRET_CONNECT: "whsec_connect_fakeSecret",
      STRIPE_CONNECT_REFRESH_URL: "https://homegrown.app/connect/refresh",
      STRIPE_CONNECT_RETURN_URL: "https://homegrown.app/connect/return",
    });

    expect(result.success).toBe(true);
    if (!result.success) return; // narrow for TS

    expect(result.data.PORT).toBe(8080);
    expect(result.data.NODE_ENV).toBe("production");
    expect(result.data.DATABASE_URL).toContain("postgres://");
    expect(result.data.JWT_SECRET).toHaveLength(46);
  });
});

// ---------------------------------------------------------------------------
// STRIPE_WEBHOOK_SECRET_CONNECT — required, must fail loudly when absent
// ---------------------------------------------------------------------------

describe("envSchema STRIPE_WEBHOOK_SECRET_CONNECT", () => {
  const validBase = {
    DATABASE_URL: "postgres://u:p@localhost:5432/homegrown",
    JWT_SECRET: "a-very-long-secret-that-is-at-least-32-chars!!",
    GOOGLE_GEOCODING_API_KEY: "geocode-key",
    STRIPE_SECRET_KEY: "sk_test_abc123",
    STRIPE_WEBHOOK_SECRET: "whsec_platform_secret",
    STRIPE_WEBHOOK_SECRET_CONNECT: "whsec_connect_secret",
  };

  it("accepts a valid STRIPE_WEBHOOK_SECRET_CONNECT", () => {
    const result = envSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("rejects when STRIPE_WEBHOOK_SECRET_CONNECT is absent", () => {
    const { STRIPE_WEBHOOK_SECRET_CONNECT: _omitted, ...without } = validBase;
    const result = envSchema.safeParse(without);
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((i) => i.path).flat();
    expect(paths).toContain("STRIPE_WEBHOOK_SECRET_CONNECT");
  });

  it("rejects when STRIPE_WEBHOOK_SECRET_CONNECT is an empty string", () => {
    const result = envSchema.safeParse({ ...validBase, STRIPE_WEBHOOK_SECRET_CONNECT: "" });
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((i) => i.path).flat();
    expect(paths).toContain("STRIPE_WEBHOOK_SECRET_CONNECT");
  });
});
