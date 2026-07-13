/**
 * Shared operator-CLI scaffold — the parts that were genuinely identical
 * across `import-places.ts`, `purge-deleted-accounts.ts`, and
 * `link-place-buyer.ts` (all three: direct-Postgres operator tools, talking
 * to the DB via the server's own drizzle client config, never through the
 * HTTP tRPC API). `test-accounts.ts` is the fourth CLI but is HTTP-only (no
 * DB access at all) — it only needs `fail`.
 *
 * Per-script `parseArgs`/USAGE text and command dispatch are left alone in
 * each script; only the identical DB/exit/entry-point plumbing lives here.
 */

import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbConnection } from "../src/db/parse-database-url.js";
import * as schema from "../src/db/schema.js";

/** Print a `✗ <message>` line to stderr and exit the process with a failure code. */
export function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Database — lazy connection so importing a script that uses this (e.g. from
// a unit test that only exercises its pure helpers) never opens a DB
// connection or requires DATABASE_URL. One module-level client per PROCESS
// is correct here: only one operator-CLI script ever runs per process.
// ---------------------------------------------------------------------------

let pgClient: ReturnType<typeof postgres> | undefined;

/** The drizzle database handle returned by `getDb()` — import this type, not `ReturnType<typeof getDb>`, in script code. */
export type OperatorDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Lazily open (and memoize) a direct Postgres connection via `DATABASE_URL`,
 * using the server's own drizzle client config. Calls `fail()` (exits the
 * process) when `DATABASE_URL` is unset.
 */
export function getDb(): OperatorDb {
  if (!pgClient) {
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) {
      fail(
        "DATABASE_URL is not set. This CLI talks directly to Postgres (operator tool), " +
          "not the HTTP API — export DATABASE_URL (e.g. from apps/server/.env) first.",
      );
    }
    const conn = dbConnection(databaseUrl);
    pgClient =
      typeof conn === "string"
        ? postgres(conn, { max: 1 })
        : postgres({ ...conn, max: 1 } as postgres.Options<Record<string, postgres.PostgresType>>);
  }
  return drizzle(pgClient, { schema });
}

/** Close the connection opened by `getDb()`, if any. Safe to call even if `getDb()` was never called. */
export async function closeDb(): Promise<void> {
  if (pgClient) await pgClient.end();
}

/**
 * True when the current module is being executed directly (`tsx
 * scripts/whatever.ts …`), false when it's merely `import`ed (e.g. by a unit
 * test that only wants the pure helper functions). Callers guard their
 * `main().catch(...)` call with this so importing a script for its exports
 * never triggers the CLI. Pass `import.meta.url` from the calling module.
 */
export function isMainModule(moduleUrl: string): boolean {
  return process.argv[1] === fileURLToPath(moduleUrl);
}
