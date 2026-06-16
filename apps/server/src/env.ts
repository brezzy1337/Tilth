/**
 * Environment validation — fails fast on missing or invalid vars.
 *
 * IMPORTANT: Only `src/index.ts` and `src/db/index.ts` should import this
 * module. Importing the router (e.g. in tests) must NOT trigger env
 * validation or a DB connection — keep this module out of the router tree.
 */

import { z } from "zod";

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
