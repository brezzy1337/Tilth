/**
 * Pure environment schema — no side effects, no process.env access, no process.exit.
 *
 * Importable by tests without triggering env validation or startup logic.
 * `env.ts` is the ONLY module allowed to call process.exit; it imports this schema
 * and is the single side-effectful entry point.
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

export const envSchema = z.object({
  /** Cloud Run injects PORT; defaults to 3001 locally. */
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Postgres connection URL — required at runtime.
   *
   * Accepts both forms:
   *   TCP:         postgres://user:pass@host:5432/db
   *   Unix-socket: postgres://user:pass@/db?host=/cloudsql/project:region:instance
   *
   * z.string().url() is intentionally NOT used here: the WHATWG URL parser rejects
   * the unix-socket form (empty host), which is what Cloud SQL injects on Cloud Run.
   */
  DATABASE_URL: z
    .string()
    .regex(
      /^postgres(?:ql)?:\/\//i,
      "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    ),
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
   * This secret corresponds to the "Your account" (platform) destination in the
   * Stripe Dashboard — handles payment_intent.* events.
   * Locally: set in .env (gitignored). Production: GCP Secret Manager.
   * No default — never hardcode.
   */
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  /**
   * Stripe webhook signing secret for the "Connected accounts" destination.
   * This is a SEPARATE secret from STRIPE_WEBHOOK_SECRET — Stripe issues one
   * signing secret per webhook endpoint, so the connected-accounts endpoint
   * (account.updated events) requires its own secret.
   * Required: a missing secret fails loudly at boot rather than silently dropping
   * connected-account events (which would re-introduce the P0 dropped-events bug).
   * Locally: set in .env (gitignored). Production: GCP Secret Manager.
   * No default — never hardcode.
   */
  STRIPE_WEBHOOK_SECRET_CONNECT: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;
