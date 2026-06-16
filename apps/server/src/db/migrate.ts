/**
 * Standalone migration runner.
 *
 * Usage:  tsx src/db/migrate.ts
 * Script: pnpm --filter @homegrown/server db:migrate
 *
 * Intentionally does NOT import `env.ts` — that module validates all five
 * runtime secrets (JWT, Stripe, Geocoding, …) which are irrelevant for a
 * migrate-only step. This script only needs DATABASE_URL.
 *
 * The drizzle migrator tracks applied migrations in the `__drizzle_migrations`
 * table, so re-running against an already-migrated database is a no-op.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATABASE_URL = process.env["DATABASE_URL"];

if (!DATABASE_URL) {
  console.error("migrate: DATABASE_URL environment variable is required but not set.");
  process.exit(1);
}

// Resolve migrations folder relative to this file regardless of CWD.
// __dirname equivalent for ESM: apps/server/src/db/
// migrationsFolder target:      apps/server/drizzle/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../drizzle");

const client = postgres(DATABASE_URL, { max: 1 });
const db = drizzle(client);

try {
  console.log(`migrate: applying migrations from ${MIGRATIONS_FOLDER} …`);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log("migrate: all migrations applied successfully.");
  process.exit(0);
} catch (err) {
  console.error("migrate: migration failed:", err);
  process.exit(1);
} finally {
  await client.end();
}
