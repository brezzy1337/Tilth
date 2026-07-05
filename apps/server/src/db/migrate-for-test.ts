/**
 * Concurrency-safe migration helper for integration tests.
 *
 * Integration test files (webhook.integration.test.ts, nearby.integration.test.ts)
 * each run `migrate()` in their own `beforeAll` against the SAME database, and
 * vitest runs test files in parallel workers. drizzle's `migrate()` is not safe
 * to run concurrently against a fresh DB: two workers both read an empty
 * migrations journal and both attempt `CREATE TABLE "users" ...`, colliding on
 * the shared catalog:
 *
 *   duplicate key value violates unique constraint "pg_type_typname_nsp_index"
 *   Key (typname, typnamespace)=(users, 2200) already exists.
 *
 * A session-level Postgres advisory lock serializes them: whichever worker wins
 * the lock migrates first; the others block until it releases, then run
 * `migrate()` against an already-migrated DB (journal populated → no-op). The
 * lock is cross-connection, so it works across separate test workers that each
 * open their own `postgres()` client.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// src/db → apps/server/drizzle
const DRIZZLE_DIR = path.resolve(__dirname, "../../drizzle");

// Arbitrary fixed key shared by every test file so they contend on the same
// lock. Namespaced high to avoid clashing with any application advisory locks.
const MIGRATION_ADVISORY_LOCK_KEY = 826_051_072; // "MIGR" as int32

export async function migrateForTest(
  client: ReturnType<typeof postgres>,
  db: Parameters<typeof migrate>[0],
): Promise<void> {
  await client`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`;
  try {
    await migrate(db, { migrationsFolder: DRIZZLE_DIR });
  } finally {
    await client`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`;
  }
}
