/**
 * Environment validation — fails fast on missing or invalid vars.
 *
 * IMPORTANT: Only `src/index.ts` and `src/db/index.ts` should import this
 * module. Importing the router (e.g. in tests) must NOT trigger env
 * validation or a DB connection — keep this module out of the router tree.
 */

import { z } from "zod";

/**
 * Reusable https-only URL validator.
 * The startsWith("https://") refine is load-bearing: z.string().url() alone
 * accepts javascript: and data: scheme URLs, which would be open-redirect vectors.
 */
const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), { message: "must be an https URL" });

const envSchema = z.object({
  /** Cloud Run injects PORT; defaults to 3001 locally. */
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Postgres connection URL — required at runtime. */
  DATABASE_URL: z.string().url(),
  /**
   * HMAC secret for signing JWTs. Must be at least 32 characters.
   * Locally: set in .env (gitignored). Production: GCP Secret Manager.
   * No default — the process exits if this is missing or too short.
   */
  JWT_SECRET: z.string().min(32),
  /**
   * Google Geocoding API key for address → lat/lng resolution.
   * Locally: set in .env (gitignored). Production: GCP Secret Manager.
   * No default — never hardcode.
   */
  GOOGLE_GEOCODING_API_KEY: z.string().min(1),
  /**
   * Stripe secret key. Must start with `rk_` (restricted key — preferred, least-privilege)
   * or `sk_` (secret key — accepted for test mode). Publishable keys (`pk_`) are rejected.
   *
   * RECOMMENDED: use a restricted key (`rk_live_…` / `rk_test_…`) scoped to only the
   * Stripe resources HomeGrown touches (PaymentIntents, Accounts, AccountLinks, Webhooks).
   * This limits blast radius if the key is ever exposed.
   *
   * Locally: set in .env (gitignored). Production: GCP Secret Manager.
   * No default — never hardcode.
   */
  STRIPE_SECRET_KEY: z
    .string()
    .min(1)
    .refine(
      (v) => v.startsWith("rk_") || v.startsWith("sk_"),
      {
        message:
          "STRIPE_SECRET_KEY must start with 'rk_' (restricted key, preferred) or 'sk_' (secret key). Publishable keys (pk_) are not accepted here.",
      },
    ),
  /**
   * Stripe Connect onboarding redirect URLs — built server-side to prevent open-redirect.
   * These are NOT secrets (no sensitive authority). Override in .env for staging/local tunnels.
   * In production, set via GCP Secret Manager or Cloud Run env vars.
   *
   * Both must be https:// URLs.
   */
  STRIPE_CONNECT_REFRESH_URL: httpsUrl.default("https://homegrown.app/connect/refresh"),
  STRIPE_CONNECT_RETURN_URL: httpsUrl.default("https://homegrown.app/connect/return"),
  /**
   * Stripe webhook signing secret (whsec_…) for verifying webhook payloads.
   * Locally: set in .env (gitignored). Production: GCP Secret Manager.
   * No default — never hardcode.
   */
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌  Invalid environment variables:\n");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
