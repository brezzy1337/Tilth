/**
 * Environment validation — fails fast on missing or invalid vars.
 *
 * IMPORTANT: Only `src/index.ts` and `src/db/index.ts` should import this
 * module. Importing the router (e.g. in tests) must NOT trigger env
 * validation or a DB connection — keep this module out of the router tree.
 *
 * The schema itself lives in `env.schema.ts` (pure, no side effects) so
 * tests can import and exercise it without triggering process.exit.
 */

import { envSchema } from "./env.schema.js";

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌  Invalid environment variables:\n");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
