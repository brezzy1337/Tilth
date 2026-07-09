/**
 * Operator CLI — links a community place (co-op/farmers market, F-048) to a
 * buyer user account so it can send/receive F-049 sourcing requests.
 *
 * HOW IT TALKS TO THE DATABASE — like `import-places.ts`, this is an
 * OPERATOR TOOL that connects DIRECTLY to Postgres via the server's own
 * drizzle client config (`../src/db/parse-database-url`, `../src/db/schema`).
 * It intentionally does NOT import `../src/env.ts` (five unrelated runtime
 * secrets) — mirrors `src/db/migrate.ts` and `import-places.ts`, which only
 * need DATABASE_URL.
 *
 * Password hashing uses the SAME `hashPassword` the auth router uses
 * (`../src/auth.ts`, scrypt) — a linked account logs in through the normal
 * `auth.login` procedure like any other user.
 *
 * CREDENTIALS — when `link` creates a NEW user, a strong random password is
 * generated and printed to stdout EXACTLY ONCE. It is never written to disk
 * or logged anywhere else — it's a bootstrap credential Devin hands to the
 * co-op/market contact, who should change it after first login (no
 * change-password endpoint exists yet; re-running `auth.register` isn't
 * possible once the account exists — the contact logs in with what's
 * printed here until that lands).
 *
 * USAGE (run from apps/server, or via `pnpm --filter @homegrown/server link-place-buyer …`):
 *
 *   pnpm link-place-buyer list
 *   pnpm link-place-buyer link --place=<uuid> --email=<email> [--username=<name>] [--yes]
 *   pnpm link-place-buyer unlink --place=<uuid> [--yes]
 *
 * Without `--yes`, `link`/`unlink` are DRY RUNS: they print the plan and
 * write nothing. `link` refuses (dry run or not) if the place is already
 * linked, or if the target user (existing or by email) is already linked to
 * a DIFFERENT place — one place, one linked account; one account, one place.
 */

import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, asc } from "drizzle-orm";
import { registerInput } from "@homegrown/shared";
import { dbConnection } from "../src/db/parse-database-url.js";
import * as schema from "../src/db/schema.js";
import { hashPassword } from "../src/auth.js";

// ---------------------------------------------------------------------------
// Database — lazy connection so importing this module (e.g. from a unit
// test) never opens a DB connection or requires DATABASE_URL.
// ---------------------------------------------------------------------------

let pgClient: ReturnType<typeof postgres> | undefined;

function getDb() {
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

async function closeDb(): Promise<void> {
  if (pgClient) await pgClient.end();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** 24 url-safe chars ≈ 144 bits of entropy; within registerInput's 8–100 bounds. */
function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Derive a `registerInput`-valid username from an email's local part when
 * `--username` isn't supplied. Non-alphanumeric/underscore chars become `_`;
 * padded to the 3-char minimum, capped at the 30-char maximum.
 */
export function deriveUsername(email: string): string {
  const local = email.split("@")[0] ?? "user";
  let cleaned = local.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 30);
  while (cleaned.length < 3) cleaned += "_";
  return cleaned;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList(): Promise<void> {
  const db = getDb();
  const places = await db
    .select({
      id: schema.communityPlaces.id,
      name: schema.communityPlaces.name,
      type: schema.communityPlaces.type,
      linkedUserId: schema.communityPlaces.linkedUserId,
    })
    .from(schema.communityPlaces)
    .where(eq(schema.communityPlaces.status, "approved"))
    .orderBy(asc(schema.communityPlaces.name));

  const linkedIds = places
    .map((p) => p.linkedUserId)
    .filter((id): id is string => id !== null);
  const emailById = new Map<string, string>();
  if (linkedIds.length > 0) {
    const users = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(inArray(schema.users.id, linkedIds));
    for (const u of users) emailById.set(u.id, u.email);
  }

  await closeDb();

  if (places.length === 0) {
    console.log("No approved places. Run `pnpm import-places` first, then approve some.");
    return;
  }

  console.log(`${places.length} approved place(s):\n`);
  for (const p of places) {
    const linked = p.linkedUserId
      ? `linked  → ${emailById.get(p.linkedUserId) ?? "(user id " + p.linkedUserId + ")"}`
      : "not linked";
    console.log(`  ${p.id}  [${p.type}]  ${p.name}`);
    console.log(`    ${linked}`);
  }
}

async function cmdLink(placeId: string, email: string, usernameArg: string | undefined, confirmed: boolean): Promise<void> {
  const emailCheck = registerInput.shape.email.safeParse(email);
  if (!emailCheck.success) {
    fail(`--email is not a valid email: "${email}"`);
  }

  const db = getDb();

  const [place] = await db
    .select({
      id: schema.communityPlaces.id,
      name: schema.communityPlaces.name,
      status: schema.communityPlaces.status,
      linkedUserId: schema.communityPlaces.linkedUserId,
    })
    .from(schema.communityPlaces)
    .where(eq(schema.communityPlaces.id, placeId))
    .limit(1);

  if (!place) {
    await closeDb();
    fail(`No place with id ${placeId}. Run \`pnpm link-place-buyer list\` to see approved places.`);
  }
  if (place.status !== "approved") {
    await closeDb();
    fail(`Place "${place.name}" is not approved (status=${place.status}) — approve it via import-places first.`);
  }
  if (place.linkedUserId) {
    await closeDb();
    fail(
      `Place "${place.name}" is already linked to user ${place.linkedUserId}. ` +
        `Run \`unlink --place=${place.id}\` first if you want to relink it.`,
    );
  }

  const [existingUser] = await db
    .select({ id: schema.users.id, email: schema.users.email, username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (existingUser) {
    const [alreadyLinked] = await db
      .select({ id: schema.communityPlaces.id, name: schema.communityPlaces.name })
      .from(schema.communityPlaces)
      .where(eq(schema.communityPlaces.linkedUserId, existingUser.id))
      .limit(1);
    if (alreadyLinked) {
      await closeDb();
      fail(
        `${email} is already linked to place "${alreadyLinked.name}" (${alreadyLinked.id}). ` +
          `One account can only be linked to one place.`,
      );
    }
  }

  let username = usernameArg;
  let generatedPassword: string | null = null;

  if (!existingUser) {
    username ??= deriveUsername(email);
    const usernameCheck = registerInput.shape.username.safeParse(username);
    if (!usernameCheck.success) {
      await closeDb();
      fail(`--username "${username}" is invalid: ${usernameCheck.error.issues[0]?.message ?? "invalid"}`);
    }
    generatedPassword = generatePassword();
  }

  console.log("Plan:");
  console.log(`  place:  "${place.name}" (${place.id})`);
  if (existingUser) {
    console.log(`  user:   existing account ${existingUser.email} (${existingUser.id}) — will be linked, no new credentials`);
  } else {
    console.log(`  user:   NEW account ${email} / username=${username} — a password will be generated and printed once`);
  }

  if (!confirmed) {
    await closeDb();
    console.log("\nDry run — nothing written. Re-run with --yes to apply.");
    return;
  }

  let userId: string;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    const passwordHash = await hashPassword(generatedPassword!);
    const [inserted] = await db
      .insert(schema.users)
      .values({ email, username: username!, passwordHash })
      .returning({ id: schema.users.id });
    if (!inserted) {
      await closeDb();
      fail("Failed to create user.");
    }
    userId = inserted.id;
  }

  await db
    .update(schema.communityPlaces)
    .set({ linkedUserId: userId, updatedAt: new Date() })
    .where(eq(schema.communityPlaces.id, place.id));

  await closeDb();

  console.log(`\n✓ linked "${place.name}" → ${email} (${userId})`);
  if (generatedPassword) {
    console.log(
      "\n  BOOTSTRAP CREDENTIAL — hand this to the co-op/market contact now; it is never\n" +
        "  written to disk or shown again:",
    );
    console.log(`    email:    ${email}`);
    console.log(`    password: ${generatedPassword}`);
  }
}

async function cmdUnlink(placeId: string, confirmed: boolean): Promise<void> {
  const db = getDb();

  const [place] = await db
    .select({
      id: schema.communityPlaces.id,
      name: schema.communityPlaces.name,
      linkedUserId: schema.communityPlaces.linkedUserId,
    })
    .from(schema.communityPlaces)
    .where(eq(schema.communityPlaces.id, placeId))
    .limit(1);

  if (!place) {
    await closeDb();
    fail(`No place with id ${placeId}.`);
  }
  if (!place.linkedUserId) {
    await closeDb();
    console.log(`Place "${place.name}" has no linked user — nothing to do.`);
    return;
  }

  console.log(`Plan: unlink "${place.name}" (${place.id}) from user ${place.linkedUserId}`);

  if (!confirmed) {
    await closeDb();
    console.log("\nDry run — nothing written. Re-run with --yes to apply.");
    return;
  }

  await db
    .update(schema.communityPlaces)
    .set({ linkedUserId: null, updatedAt: new Date() })
    .where(eq(schema.communityPlaces.id, place.id));

  await closeDb();
  console.log(`\n✓ unlinked "${place.name}". The user account itself is untouched (no delete endpoint exists).`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `Place-buyer link CLI (F-049) — talks directly to Postgres (operator tool).

Commands:
  list                        List approved places with id, type, and linked
                               status (+ linked user email if set).
  link --place=<uuid> --email=<email> [--username=<name>] [--yes]
                               Link a place to a buyer account. If a user with
                               that email exists, links it; otherwise creates
                               one (username derived from the email's local
                               part if omitted) and prints a generated
                               bootstrap password ONCE. Refuses if the place
                               is already linked, or the user is already
                               linked to a different place. Without --yes,
                               prints the plan and writes nothing (dry run).
  unlink --place=<uuid> [--yes]
                               Clear a place's linked user. Without --yes,
                               prints the plan and writes nothing (dry run).

Env:
  DATABASE_URL                 Required — this tool writes directly to Postgres.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      place: { type: "string" },
      email: { type: "string" },
      username: { type: "string" },
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
    case "link": {
      if (!values.place || !values.email) fail("link requires --place=<uuid> and --email=<email>.");
      await cmdLink(values.place, values.email, values.username, values.yes === true);
      break;
    }
    case "unlink": {
      if (!values.place) fail("unlink requires --place=<uuid>.");
      await cmdUnlink(values.place, values.yes === true);
      break;
    }
    default:
      console.log(USAGE);
      fail(`Unknown command "${command}".`);
  }
}

// Only run the CLI when this file is executed directly (`tsx scripts/link-place-buyer.ts …`),
// never when a test imports it for the pure helper functions above.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
