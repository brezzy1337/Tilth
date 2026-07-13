/**
 * Operator CLI — anonymizes (never row-deletes) accounts past their F-051
 * 30-day soft-delete grace period (`users.deleteAfter`).
 *
 * HOW IT TALKS TO THE DATABASE — like `import-places.ts` / `link-place-buyer.ts`,
 * this is an OPERATOR TOOL that connects DIRECTLY to Postgres via the server's
 * own drizzle client config (`../src/db/parse-database-url`, `../src/db/schema`).
 * It intentionally does NOT import `../src/env.ts` (five unrelated runtime
 * secrets) — mirrors `src/db/migrate.ts` and the other operator CLIs, which
 * only need DATABASE_URL.
 *
 * WHY ANONYMIZE, NOT DELETE — `orders`, `messages`, `order_items`, etc. all
 * FK-reference `users.id`; row-deleting a user would either cascade-destroy
 * order/message history or violate those FKs. `auth.deleteAccount` already
 * did the meaningful teardown (deactivated the account, withdrew pending
 * sourcing requests, deleted push tokens); this CLI is the SECOND stage,
 * run by the operator once `deleteAfter` has passed, that scrubs personally
 * identifying fields while leaving the row (and its order/message history)
 * intact for the counterparties who transacted with it. `deactivatedAt` /
 * `deleteAfter` are left SET after purge (not cleared) — that keeps every
 * deactivation-gated discovery filter (helpers.ts's `activeUserClause` /
 * `isUserDeactivated`) correctly still hiding this account.
 *
 * WHAT GETS ANONYMIZED, per purged user:
 *   - email          -> deleted-<userId>@deleted.invalid
 *   - username        -> deleted-<8 random hex chars> (retried on a unique-
 *                        constraint collision, vanishingly unlikely)
 *   - passwordHash    -> hash of a random 32-byte secret, generated with the
 *                        SAME `hashPassword` the auth router uses, and NEVER
 *                        printed or stored anywhere else (the account can no
 *                        longer log in — it was already past its 30-day
 *                        self-restore window when this runs)
 *   - stripeCustomerId -> null
 *   - push_tokens rows -> deleted
 *   - user_blocks rows -> deleted (both directions: as blocker AND as blocked)
 *   - their store (if any) -> renamed to "Deleted stand", logo/about cleared
 *
 * USAGE (run from apps/server, or via `pnpm --filter @homegrown/server purge-deleted-accounts …`):
 *
 *   pnpm purge-deleted-accounts list
 *   pnpm purge-deleted-accounts purge [--yes]
 *
 * Without `--yes`, `purge` is a DRY RUN: it prints the plan and writes nothing.
 */

import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { eq, and, or, isNotNull, lte, asc } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import { hashPassword } from "../src/auth.js";
import { fail, getDb, closeDb, isMainModule, type OperatorDb } from "./lib.js";

/** The name a purged user's store is renamed to — never leave a store's own name PII-bearing. */
export const DELETED_STORE_NAME = "Deleted stand";

// ---------------------------------------------------------------------------
// Pure transforms — exported for unit testing (no DB, no randomness beyond
// the caller-supplied suffix so they're deterministic to test).
// ---------------------------------------------------------------------------

/** Anonymized email for a purged user — deterministic on their (already-opaque) id. */
export function anonymizedEmail(userId: string): string {
  return `deleted-${userId}@deleted.invalid`;
}

/**
 * Mask an email for stdout: keeps the first char of the local part and the
 * first char of the domain, replaces the rest with `*`s (e.g.
 * "jane@example.com" -> "j***@e***.com" — the TLD is kept as-is since it
 * carries no PII on its own). Never used for anything but display — the raw
 * email is still what's written to the DB (pre-anonymization) or read from
 * it; this only governs what this CLI prints.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***"; // malformed — never print it verbatim
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const domainHead = dot > 0 ? domain.slice(0, dot) : domain;
  const domainTail = dot > 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${domainHead[0] ?? "*"}***${domainTail}`;
}

/** Anonymized username for a purged user, given an 8-hex-char random suffix. */
export function anonymizedUsername(randomSuffix: string): string {
  return `deleted-${randomSuffix}`;
}

/** 8 lowercase hex chars — short, URL-safe, and within registerInput's username bounds. */
function randomUsernameSuffix(): string {
  return randomBytes(4).toString("hex");
}

/** Local alias — `purgeOneUser`/`loadAccountsPastGrace` below were written against this name. */
type Database = OperatorDb;

// ---------------------------------------------------------------------------
// Shared query — accounts past their grace period
// ---------------------------------------------------------------------------

async function loadAccountsPastGrace(db: Database) {
  // No `username` here — this row set only ever reaches stdout (`list`/`purge`
  // plans), which redacts to userId + a masked email; the raw username isn't
  // needed for that and shouldn't be pulled just to sit unused in memory.
  return db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      deleteAfter: schema.users.deleteAfter,
    })
    .from(schema.users)
    .where(and(isNotNull(schema.users.deleteAfter), lte(schema.users.deleteAfter, new Date())))
    .orderBy(asc(schema.users.deleteAfter));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList(): Promise<void> {
  const db = getDb();
  const rows = await loadAccountsPastGrace(db);
  await closeDb();

  if (rows.length === 0) {
    console.log("No accounts past their 30-day grace period.");
    return;
  }

  console.log(`${rows.length} account(s) past grace — \`purge\` would anonymize:\n`);
  for (const r of rows) {
    // PII redaction — userId + a masked email only; never print the raw
    // email/username to stdout (this CLI's output can end up in shell
    // history, CI logs, etc.).
    console.log(`  ${r.id}  ${maskEmail(r.email)}  (deleteAfter: ${r.deleteAfter?.toISOString()})`);
  }
}

/**
 * Anonymize a single purged user: email/username/passwordHash/stripeCustomerId
 * scrubbed, their push_tokens + user_blocks (both directions) deleted, and
 * their store (if any) renamed with logo/about cleared. `deactivatedAt` /
 * `deleteAfter` are left untouched (already set, past grace) — see the file
 * doc comment for why they must stay set.
 *
 * All four writes (users scrub, push_tokens delete, user_blocks delete, store
 * rename) run inside ONE `db.transaction` — a failure partway through (e.g.
 * the username-collision retry loop exhausting its attempts) must not leave
 * the row half-scrubbed (e.g. push tokens gone but the email still real).
 */
export async function purgeOneUser(db: Database, userId: string): Promise<{ hadStore: boolean }> {
  const randomSecret = randomBytes(32).toString("hex");
  const passwordHash = await hashPassword(randomSecret);
  const email = anonymizedEmail(userId);

  return db.transaction(async (tx) => {
    // Username collisions are vanishingly unlikely (8 random hex chars) but
    // not impossible — retry with a fresh suffix on a unique-violation
    // (SQLSTATE 23505), same pattern as auth.register's concurrent-duplicate
    // handling. Each attempt runs in its OWN nested transaction (SAVEPOINT,
    // via drizzle's `tx.transaction()`) — a plain UPDATE here would instead
    // abort the WHOLE outer transaction on a unique-violation, poisoning
    // every subsequent statement (push_tokens/user_blocks deletes, store
    // rename) with "current transaction is aborted".
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const username = anonymizedUsername(randomUsernameSuffix());
      try {
        await tx.transaction(async (tx2) => {
          await tx2
            .update(schema.users)
            .set({ email, username, passwordHash, stripeCustomerId: null })
            .where(eq(schema.users.id, userId));
        });
        break;
      } catch (err) {
        const isUniqueViolation =
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: unknown }).code === "23505";
        if (isUniqueViolation && attempt < MAX_ATTEMPTS) continue;
        throw err;
      }
    }

    await tx.delete(schema.pushTokens).where(eq(schema.pushTokens.userId, userId));
    await tx
      .delete(schema.userBlocks)
      .where(
        or(
          eq(schema.userBlocks.blockerUserId, userId),
          eq(schema.userBlocks.blockedUserId, userId),
        ),
      );

    const [store] = await tx
      .select({ id: schema.stores.id })
      .from(schema.stores)
      .where(eq(schema.stores.userId, userId))
      .limit(1);

    if (store) {
      await tx
        .update(schema.stores)
        .set({ name: DELETED_STORE_NAME, logo: null, about: null })
        .where(eq(schema.stores.id, store.id));
    }

    return { hadStore: !!store };
  });
}

async function cmdPurge(confirmed: boolean): Promise<void> {
  const db = getDb();
  const rows = await loadAccountsPastGrace(db);

  if (rows.length === 0) {
    await closeDb();
    console.log("No accounts past their 30-day grace period. Nothing to purge.");
    return;
  }

  console.log(`Plan: anonymize ${rows.length} account(s) past grace:`);
  for (const r of rows) {
    // PII redaction — same convention as `list` above.
    console.log(`  ${r.id}  ${maskEmail(r.email)}`);
  }

  if (!confirmed) {
    await closeDb();
    console.log("\nDry run — nothing written. Re-run with --yes to apply.");
    return;
  }

  console.log("");
  for (const r of rows) {
    const { hadStore } = await purgeOneUser(db, r.id);
    console.log(
      `  ✓ ${r.id} anonymized${hadStore ? ` (store renamed to "${DELETED_STORE_NAME}")` : ""}`,
    );
  }

  await closeDb();
  console.log(`\n✓ purged ${rows.length} account(s).`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `Purge-deleted-accounts CLI (F-051) — talks directly to Postgres (operator tool).

Commands:
  list             List accounts past their 30-day soft-delete grace period
                    (users.deleteAfter <= now) with what \`purge\` would do.
  purge [--yes]     Anonymize (never row-delete) every account past grace:
                    scrubs email/username/passwordHash/stripeCustomerId,
                    deletes their push_tokens + user_blocks, and renames
                    their store (if any). deactivatedAt/deleteAfter are left
                    set. Without --yes, prints the plan and writes nothing
                    (dry run).

Env:
  DATABASE_URL      Required — this tool writes directly to Postgres.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case "list":
      await cmdList();
      break;
    case "purge":
      await cmdPurge(values.yes === true);
      break;
    default:
      console.log(USAGE);
      fail(`Unknown command "${command}".`);
  }
}

// Only run the CLI when this file is executed directly (`tsx scripts/purge-deleted-accounts.ts …`),
// never when a test imports it for the pure helper functions above.
if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
