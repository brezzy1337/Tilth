/**
 * Auth router — register, login, and session principal.
 *
 * All procedures read `ctx.db`, `ctx.jwtSecret`, and `ctx.auth` (the auth
 * helpers injected by index.ts). No direct imports of env, db, or auth.ts —
 * keeping this module's import tree compatible with mobile's typecheck (which
 * cannot resolve node:crypto / Buffer without @types/node).
 *
 * Security notes:
 * - Passwords are never returned in any output.
 * - Login errors are intentionally generic (do not reveal which field failed).
 * - Duplicate checks use CONFLICT so the client can handle them specifically.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  authResponse,
  loginInput,
  registerInput,
  sessionUser,
  changePasswordInput,
  deleteAccountInput,
  deleteAccountOutput,
  requestRestoreCodeInput,
  requestRestoreCodeOutput,
  verifyRestoreInput,
  otpPurpose,
  RESTORE_CODE_TTL_MINUTES,
  RESTORE_CODE_MAX_ATTEMPTS,
  RESTORE_CODE_RESEND_COOLDOWN_SECONDS,
  RESTORE_CODE_MAX_PER_HOUR,
  RESTORE_VERIFICATION_REQUIRED,
} from "@homegrown/shared";
import { eq, or, and, notExists, notInArray, desc, isNull, gt, count, sql } from "drizzle-orm";
import { publicProcedure, protectedProcedure, router } from "../trpc";
import { users, stores, orders, sourcingRequests, pushTokens, restoreCodes } from "../db/schema";
import { TERMINAL_ORDER_STATUSES } from "../db/order-transitions";
import type { DbOrTx } from "../db/order-transitions";
import { maskEmail } from "../mask";
import type { Db, AuthHelpers, EmailClient } from "../context";

/** F-051 — the soft-delete grace period; see `deleteAccount` below. */
const DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Fetch `userId`'s stored password hash and verify `plainPassword` against
 * it, throwing the SAME generic "Invalid credentials" UNAUTHORIZED TRPCError
 * on either a missing row or a hash mismatch — never distinguishes the two.
 * The ONE fetch-hash -> verifyPassword -> UNAUTHORIZED sequence shared by
 * `changePassword` and `deleteAccount` (both look up by `ctx.user.id`).
 *
 * `login` does NOT go through this helper — it looks up by
 * `usernameOrEmail` (not a user id already known to be valid, as
 * `protectedProcedure` guarantees here) and additionally reads the
 * deactivation fields for its self-restore logic, so its fetch has a
 * different shape. See `login`'s own doc comment for its documented,
 * pre-existing timing-gap note (intentionally left unfixed here).
 */
async function requirePasswordMatch(
  db: Db,
  auth: AuthHelpers,
  userId: string,
  plainPassword: string,
): Promise<void> {
  const [found] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const invalidCredentials = () =>
    new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });

  if (!found) throw invalidCredentials();

  const valid = await auth.verifyPassword(plainPassword, found.passwordHash);
  if (!valid) throw invalidCredentials();
}

// ---------------------------------------------------------------------------
// F-054 — email-verified account restore
//
// Today (no SendGrid configured, `ctx.email === null`): a password-verified
// `login` on a deactivated-in-grace account SILENTLY self-restores, exactly
// as before F-054. Once `SENDGRID_API_KEY` is mounted (`ctx.email` non-null),
// that silent restore is replaced by an emailed 6-digit code the caller must
// submit to `verifyRestore` — `login` instead throws a FORBIDDEN
// `RESTORE_VERIFICATION_REQUIRED` challenge. This is the env-gated rollout
// switch: the feature is completely dark until the key exists (mirrors the
// Mux/GCS `ctx.mux`/`ctx.media` null-gating pattern in `garden.ts`).
// ---------------------------------------------------------------------------

/** Mirrors the shared `otpPurpose` enum's only member today. */
const RESTORE_PURPOSE = otpPurpose.enum.account_restore;

const RESTORE_COOLDOWN_MS = RESTORE_CODE_RESEND_COOLDOWN_SECONDS * 1000;

/** The row shape `login`/`requestRestoreCode`/`verifyRestore` all look up by usernameOrEmail. */
interface LoginLookupRow {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  deactivatedAt: Date | null;
  deleteAfter: Date | null;
}

/** Generic, oracle-free "wrong credentials" error — the ONE UNAUTHORIZED shape shared by login/requestRestoreCode/verifyRestore for credential failures. */
function invalidCredentialsError(): TRPCError {
  return new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
}

/**
 * Look up a user by `usernameOrEmail` and verify `password` against the
 * stored hash, throwing the SAME generic `invalidCredentialsError()` on
 * either a missing row or a hash mismatch — never distinguishes the two.
 * Shared by `login`, `requestRestoreCode`, and `verifyRestore` so all three
 * surfaces fail identically on bad credentials (no account-existence oracle).
 *
 * Pre-existing, documented timing gap (not fixed here, same as before this
 * helper was extracted): the DB lookup and the hash verify take measurably
 * different time depending on whether `found` exists (a real scrypt verify
 * vs. none at all) — a timing side-channel for username/email enumeration.
 */
async function verifyLoginCredentials(
  db: Db,
  auth: AuthHelpers,
  usernameOrEmail: string,
  password: string,
): Promise<LoginLookupRow> {
  const [found] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      passwordHash: users.passwordHash,
      deactivatedAt: users.deactivatedAt,
      deleteAfter: users.deleteAfter,
    })
    .from(users)
    .where(or(eq(users.email, usernameOrEmail), eq(users.username, usernameOrEmail)))
    .limit(1);

  if (!found) throw invalidCredentialsError();

  const valid = await auth.verifyPassword(password, found.passwordHash);
  if (!valid) throw invalidCredentialsError();

  return found;
}

/** True when `row` is deactivated AND still within its 30-day grace window. */
function isDeactivatedInGrace(row: Pick<LoginLookupRow, "deactivatedAt" | "deleteAfter">): boolean {
  return row.deactivatedAt !== null && row.deleteAfter !== null && row.deleteAfter.getTime() > Date.now();
}

/**
 * Clears `deactivatedAt`/`deleteAfter` — the ONE account-restore write,
 * shared by `login`'s legacy silent path and `verifyRestore`'s
 * code-confirmed path. Takes `DbOrTx` (not just `Db`) so `verifyRestore` can
 * call it INSIDE its own transaction, alongside marking the code consumed
 * and deleting other outstanding codes — all three writes commit or roll
 * back together (see `verifyRestore` below).
 */
async function restoreDeactivatedAccount(db: DbOrTx, userId: string): Promise<void> {
  await db.update(users).set({ deactivatedAt: null, deleteAfter: null }).where(eq(users.id, userId));
}

/** The single newest restore-code row for `userId`/`RESTORE_PURPOSE`, regardless of consumed/expired state — used for cooldown/hourly-cap bookkeeping. */
async function latestRestoreCode(
  db: DbOrTx,
  userId: string,
): Promise<{ createdAt: Date; consumedAt: Date | null } | undefined> {
  const [row] = await db
    .select({ createdAt: restoreCodes.createdAt, consumedAt: restoreCodes.consumedAt })
    .from(restoreCodes)
    .where(and(eq(restoreCodes.userId, userId), eq(restoreCodes.purpose, RESTORE_PURPOSE)))
    .orderBy(desc(restoreCodes.createdAt))
    .limit(1);
  return row;
}

/** True when the newest code is unconsumed AND younger than `RESTORE_CODE_RESEND_COOLDOWN_SECONDS`. */
function isWithinResendCooldown(latest: { createdAt: Date; consumedAt: Date | null } | undefined): boolean {
  if (!latest || latest.consumedAt) return false;
  return Date.now() - latest.createdAt.getTime() < RESTORE_COOLDOWN_MS;
}

/** Count of `userId`/`RESTORE_PURPOSE` codes created in the last rolling hour — the RESTORE_CODE_MAX_PER_HOUR cap. */
async function restoreCodeCountLastHour(db: DbOrTx, userId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [row] = await db
    .select({ count: count() })
    .from(restoreCodes)
    .where(
      and(
        eq(restoreCodes.userId, userId),
        eq(restoreCodes.purpose, RESTORE_PURPOSE),
        gt(restoreCodes.createdAt, since),
      ),
    );
  return row?.count ?? 0;
}

/**
 * True when a currently-valid (unconsumed AND unexpired) restore code exists
 * for `userId` — the SAME lookup `verifyRestore` uses to find a submittable
 * code. Used by `login`'s hourly-cap edge (see `issueRestoreCode`'s "capped"
 * result below) to decide between issuing the `RESTORE_VERIFICATION_REQUIRED`
 * challenge (a code the caller can still submit exists) and TOO_MANY_REQUESTS
 * (no usable code exists — a challenge would be a dead end).
 */
async function hasValidUnexpiredCode(db: DbOrTx, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: restoreCodes.id })
    .from(restoreCodes)
    .where(
      and(
        eq(restoreCodes.userId, userId),
        eq(restoreCodes.purpose, RESTORE_PURPOSE),
        isNull(restoreCodes.consumedAt),
        gt(restoreCodes.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return !!row;
}

/** Outcome of `issueRestoreCode` — what the caller should do next. */
type RestoreCodeIssueResult =
  | { status: "sent"; code: string }
  | { status: "cooldown" }
  | { status: "capped" };

/**
 * Atomically decide whether to create a fresh restore code for `userId`,
 * enforcing the resend cooldown and hourly cap — WITHOUT sending the email
 * (callers send it themselves, using the returned plaintext `code`, AFTER
 * this transaction has committed — a slow network call to SendGrid must
 * never hold the lock below open).
 *
 * CRITICAL (F-054 review fix — rate-limit TOCTOU): the cooldown read, the
 * hourly-count read, and the insert used to run as three separate
 * statements with no lock between them — N parallel requests for the same
 * user could all observe "under cap" before any of them inserted, bypassing
 * both the cooldown and the hourly cap. This now runs the reads + the insert
 * inside ONE transaction that FIRST takes
 * `pg_advisory_xact_lock(hashtext(userId))` — a transaction-scoped advisory
 * lock (auto-released on commit/rollback; no manual unlock needed) that
 * serializes every concurrent caller for the SAME user (a different user's
 * call is unaffected; a `hashtext` collision between two different users'
 * ids would only cost them a harmless, vanishingly rare false wait, never a
 * correctness problem). `login`'s auto-send path and `requestRestoreCode`
 * BOTH go through this one function so neither can race the other, or
 * itself.
 */
async function issueRestoreCode(
  db: Db,
  auth: AuthHelpers,
  userId: string,
): Promise<RestoreCodeIssueResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);

    const latest = await latestRestoreCode(tx, userId);
    if (isWithinResendCooldown(latest)) return { status: "cooldown" };

    const countLastHour = await restoreCodeCountLastHour(tx, userId);
    if (countLastHour >= RESTORE_CODE_MAX_PER_HOUR) return { status: "capped" };

    const code = auth.generateRestoreCode();
    const codeHash = await auth.hashPassword(code);
    const expiresAt = new Date(Date.now() + RESTORE_CODE_TTL_MINUTES * 60_000);

    await tx.insert(restoreCodes).values({ userId, purpose: RESTORE_PURPOSE, codeHash, expiresAt });

    return { status: "sent", code };
  });
}

/**
 * Email a restore code to `toEmail`. Deliberately separate from
 * `issueRestoreCode` (see its doc comment) — this is the ONE place the TTL
 * is interpolated into the email body, from the shared
 * `RESTORE_CODE_TTL_MINUTES` constant rather than a hardcoded string.
 */
async function sendRestoreCodeEmail(email: EmailClient, toEmail: string, code: string): Promise<void> {
  await email.sendEmail({
    to: toEmail,
    subject: "Your Tilth restore code",
    text: `Your Tilth restore code is ${code}. It expires in ${RESTORE_CODE_TTL_MINUTES} minutes. If you didn't try to restore your account, you can ignore this.`,
  });
}

export const authRouter = router({
  /**
   * Register a new user. Returns a signed JWT and the safe session principal.
   * Conflicts on duplicate email OR username (CONFLICT — distinct from bad input).
   */
  register: publicProcedure
    .input(registerInput)
    .output(authResponse)
    .mutation(async ({ input, ctx }) => {
      // Check for duplicate email or username
      const existing = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(
          or(eq(users.email, input.email), eq(users.username, input.username)),
        )
        .limit(1);

      if (existing.length > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Email or username is already taken",
        });
      }

      const passwordHash = await ctx.auth.hashPassword(input.password);

      let newUser: { id: string; email: string; username: string } | undefined;
      try {
        const [inserted] = await ctx.db
          .insert(users)
          .values({
            email: input.email,
            username: input.username,
            passwordHash,
          })
          .returning({
            id: users.id,
            email: users.email,
            username: users.username,
          });
        newUser = inserted;
      } catch (err) {
        // Postgres unique-violation (SQLSTATE 23505) means a concurrent duplicate
        // slipped past the precheck SELECT — surface it as a clean CONFLICT.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: unknown }).code === "23505"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Email or username is already taken",
          });
        }
        throw err;
      }

      if (!newUser) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create user",
        });
      }

      const token = await ctx.auth.signToken(newUser.id, ctx.jwtSecret);

      return {
        token,
        user: {
          id: newUser.id,
          email: newUser.email,
          username: newUser.username,
        },
      };
    }),

  /**
   * Login with email or username + password.
   * Returns a signed JWT and the safe session principal.
   * Uses a generic error message to avoid revealing which field failed.
   *
   * F-051 — deactivated accounts (`auth.deleteAccount`, soft-delete + 30-day
   * grace): a password-verified login inside the grace window (`deleteAfter`
   * still in the future) restores the account and proceeds as a normal
   * login. Past the grace window (or a malformed state — `deleteAfter`
   * unset while `deactivatedAt` is set), login is rejected with the SAME
   * generic UNAUTHORIZED message as a wrong password — an attacker probing
   * usernames/emails must not be able to distinguish "wrong password" from
   * "this account was deleted".
   *
   * F-054 — email-verified restore, ENV-GATED on `ctx.email` (non-null only
   * once `SENDGRID_API_KEY` is configured):
   *   - `ctx.email === null` (SendGrid not configured): unchanged from
   *     F-051 — the account SELF-RESTORES silently right here, no code
   *     challenge. This is the "feature dark" state; today's behavior is
   *     preserved byte-for-byte.
   *   - `ctx.email !== null`: silent restore is replaced by an emailed
   *     6-digit code, issued atomically via `issueRestoreCode` (see its doc
   *     comment for the rate-limit-TOCTOU fix). Three outcomes:
   *       - "sent": a fresh code was created — email it, then throw FORBIDDEN
   *         `RESTORE_VERIFICATION_REQUIRED`.
   *       - "cooldown": a fresh unconsumed code already exists (younger than
   *         the resend cooldown, so necessarily still unexpired — the
   *         cooldown is 60s, well under the 10-minute TTL) — do NOT send
   *         again, but still throw the same challenge; the caller has a
   *         usable code.
   *       - "capped": the hourly cap is reached. If a currently-valid
   *         (unconsumed, unexpired) code STILL exists from an earlier send
   *         this hour, throw the same challenge (no send) — the caller has
   *         something to submit. Otherwise every code from this hour has
   *         expired, so a challenge would be a dead end: throw
   *         TOO_MANY_REQUESTS instead (post-review fix — this used to always
   *         throw the challenge here, sending the user to a code screen with
   *         no valid code in existence).
   *     The account is NOT restored in any of these branches; that only
   *     happens once `verifyRestore` confirms the emailed code.
   */
  login: publicProcedure
    .input(loginInput)
    .output(authResponse)
    .mutation(async ({ input, ctx }) => {
      const found = await verifyLoginCredentials(
        ctx.db,
        ctx.auth,
        input.usernameOrEmail,
        input.password,
      );

      if (found.deactivatedAt) {
        if (!isDeactivatedInGrace(found)) throw invalidCredentialsError();

        if (ctx.email) {
          const result = await issueRestoreCode(ctx.db, ctx.auth, found.id);

          if (result.status === "sent") {
            await sendRestoreCodeEmail(ctx.email, found.email, result.code);
            throw new TRPCError({ code: "FORBIDDEN", message: RESTORE_VERIFICATION_REQUIRED });
          }

          if (result.status === "cooldown") {
            throw new TRPCError({ code: "FORBIDDEN", message: RESTORE_VERIFICATION_REQUIRED });
          }

          // result.status === "capped" — only challenge if there's actually
          // a valid code left to submit; otherwise this is a dead end.
          if (await hasValidUnexpiredCode(ctx.db, found.id)) {
            throw new TRPCError({ code: "FORBIDDEN", message: RESTORE_VERIFICATION_REQUIRED });
          }
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Too many restore attempts. Try again later.",
          });
        }

        // Feature dark (no SendGrid configured) — pre-F-054 silent self-restore,
        // unchanged: clears both fields so every deactivation-gated surface
        // (helpers.ts's activeUserClause/isUserDeactivated) sees this account
        // as active again from this point on.
        await restoreDeactivatedAccount(ctx.db, found.id);
      }

      const token = await ctx.auth.signToken(found.id, ctx.jwtSecret);

      return {
        token,
        user: {
          id: found.id,
          email: found.email,
          username: found.username,
        },
      };
    }),

  /**
   * Request a fresh restore code for a deactivated-in-grace account (F-054).
   * Public — re-verifies credentials exactly like `login` (same generic
   * UNAUTHORIZED on a wrong password, unknown account, an ACTIVE account, or
   * an account past its grace window — no account-existence or
   * deactivation-state oracle; a live account never needs this endpoint).
   *
   * Rate-limited per (user, purpose): at most one send per
   * `RESTORE_CODE_RESEND_COOLDOWN_SECONDS`, and at most
   * `RESTORE_CODE_MAX_PER_HOUR` sends per rolling hour — both TOO_MANY_REQUESTS.
   *
   * Mobile calls this to resend a code after `login` throws the
   * `RESTORE_VERIFICATION_REQUIRED` challenge (see `login` above); it is a
   * no-op-safe way to trigger the SAME code-issuing path outside of a login
   * attempt.
   */
  requestRestoreCode: publicProcedure
    .input(requestRestoreCodeInput)
    .output(requestRestoreCodeOutput)
    .mutation(async ({ input, ctx }) => {
      const found = await verifyLoginCredentials(
        ctx.db,
        ctx.auth,
        input.usernameOrEmail,
        input.password,
      );

      // Same generic error for a live account, a past-grace account, AND a
      // feature-dark environment (no SendGrid) — none of these may be
      // distinguishable from a wrong password.
      if (!ctx.email || !isDeactivatedInGrace(found)) throw invalidCredentialsError();

      // Same atomic issue path `login`'s auto-send uses — see
      // `issueRestoreCode`'s doc comment for the rate-limit-TOCTOU fix.
      const result = await issueRestoreCode(ctx.db, ctx.auth, found.id);

      if (result.status === "cooldown") {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Please wait before requesting another code.",
        });
      }
      if (result.status === "capped") {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many restore code requests. Try again later.",
        });
      }

      await sendRestoreCodeEmail(ctx.email, found.email, result.code);

      return { sent: true, maskedEmail: maskEmail(found.email) };
    }),

  /**
   * Submit a restore code and complete reactivation (F-054). Public —
   * re-verifies credentials exactly like `login`/`requestRestoreCode` (same
   * generic UNAUTHORIZED for a wrong password, unknown account, a non-
   * deactivated-in-grace account, or a feature-dark environment).
   *
   * Loads the newest unconsumed, unexpired code for (user, purpose),
   * ATOMICALLY increments its `attempts` (UPDATE...RETURNING — no TOCTOU
   * between reading and bumping the counter), and rejects once attempts
   * exceeds `RESTORE_CODE_MAX_ATTEMPTS` — even if the submitted code is
   * correct on that very attempt. A missing/expired/consumed code and a
   * wrong code all produce the SAME generic UNAUTHORIZED (no "wrong code vs
   * expired" distinction).
   *
   * On match: marks the code consumed, restores the account via the SAME
   * `restoreDeactivatedAccount` write `login`'s legacy silent path uses,
   * deletes every other outstanding (unconsumed) code for this user, and
   * returns the same `authResponse` shape `login` returns.
   */
  verifyRestore: publicProcedure
    .input(verifyRestoreInput)
    .output(authResponse)
    .mutation(async ({ input, ctx }) => {
      const found = await verifyLoginCredentials(
        ctx.db,
        ctx.auth,
        input.usernameOrEmail,
        input.password,
      );

      if (!ctx.email || !isDeactivatedInGrace(found)) throw invalidCredentialsError();

      const invalidCode = () =>
        new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired code" });

      const [codeRow] = await ctx.db
        .select({ id: restoreCodes.id, codeHash: restoreCodes.codeHash })
        .from(restoreCodes)
        .where(
          and(
            eq(restoreCodes.userId, found.id),
            eq(restoreCodes.purpose, RESTORE_PURPOSE),
            isNull(restoreCodes.consumedAt),
            gt(restoreCodes.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(restoreCodes.createdAt))
        .limit(1);

      if (!codeRow) throw invalidCode();

      // Atomic increment (UPDATE...RETURNING) — no separate read-then-write
      // gap for two concurrent verify attempts to race past the cap.
      const [updated] = await ctx.db
        .update(restoreCodes)
        .set({ attempts: sql`${restoreCodes.attempts} + 1` })
        .where(eq(restoreCodes.id, codeRow.id))
        .returning({ attempts: restoreCodes.attempts });

      if (!updated || updated.attempts > RESTORE_CODE_MAX_ATTEMPTS) throw invalidCode();

      const matches = await ctx.auth.verifyPassword(input.code, codeRow.codeHash);
      if (!matches) throw invalidCode();

      await ctx.db.transaction(async (tx) => {
        await tx
          .update(restoreCodes)
          .set({ consumedAt: new Date() })
          .where(eq(restoreCodes.id, codeRow.id));

        // The SAME `restoreDeactivatedAccount` write `login`'s legacy silent
        // path uses (post-review fix — this used to be inlined here, drifting
        // from the doc comment above claiming it used the helper).
        await restoreDeactivatedAccount(tx, found.id);

        // Delete every OTHER outstanding (unconsumed) code for this user —
        // the just-consumed row above no longer matches `isNull(consumedAt)`
        // and survives for audit purposes.
        await tx
          .delete(restoreCodes)
          .where(
            and(
              eq(restoreCodes.userId, found.id),
              eq(restoreCodes.purpose, RESTORE_PURPOSE),
              isNull(restoreCodes.consumedAt),
            ),
          );
      });

      const token = await ctx.auth.signToken(found.id, ctx.jwtSecret);

      return {
        token,
        user: {
          id: found.id,
          email: found.email,
          username: found.username,
        },
      };
    }),

  /**
   * Change the caller's password (protected). Verifies `currentPassword`
   * against the stored hash with the SAME verifier `login` uses; a mismatch
   * is UNAUTHORIZED (does not reveal that the current-password check,
   * specifically, is what failed — same generic-error posture as `login`).
   *
   * Existing JWTs remain valid after a password change — auth is stateless
   * (no server-side session store to invalidate); acceptable for v1. See
   * `trpc.ts`'s `protectedProcedure` doc comment for the related F-051 gap.
   */
  changePassword: protectedProcedure
    .input(changePasswordInput)
    .output(z.object({ success: z.literal(true) }))
    .mutation(async ({ input, ctx }) => {
      await requirePasswordMatch(ctx.db, ctx.auth, ctx.user.id, input.currentPassword);

      const newPasswordHash = await ctx.auth.hashPassword(input.newPassword);

      await ctx.db
        .update(users)
        .set({ passwordHash: newPasswordHash })
        .where(eq(users.id, ctx.user.id));

      return { success: true };
    }),

  /**
   * Soft-delete the caller's account (protected), password-confirmed.
   *
   * Refuses (BAD_REQUEST) if the caller has any NON-terminal order (see
   * `TERMINAL_ORDER_STATUSES` in `db/order-transitions.ts` — anything other
   * than fulfilled/cancelled/refunded is "in flight") as buyer, OR as the
   * owner of a store with such an order — deleting mid-transaction would
   * strand a counterparty.
   *
   * CRITICAL (post-review fix) — that open-order check used to run as a
   * separate pre-check SELECT before the transaction below opened. That left
   * a TOCTOU gap: an order created in the window between the pre-check and
   * the deactivation write was invisible to the check, so the account could
   * still be deleted out from under a just-created order. The guard now
   * lives INSIDE the `users` UPDATE's own WHERE clause (`NOT EXISTS` on both
   * "open order as buyer" and "open order as the owner of a store with one")
   * — atomic with the write it protects, so there is no gap for a concurrent
   * order to land in. A 0-row UPDATE result means the guard tripped (or the
   * row vanished, which `protectedProcedure` makes impossible) and is
   * surfaced as the same BAD_REQUEST as before.
   *
   * On success, in one transaction (the guarded `users` UPDATE runs FIRST —
   * the other writes only happen once it's actually claimed the row):
   *   - sets `deactivatedAt = now`, `deleteAfter = now + 30d` — this alone
   *     hides the caller's selling surfaces from discovery (see helpers.ts's
   *     `activeUserClause` / `isUserDeactivated`) and blocks new messages/
   *     sourcing requests TO them.
   *   - withdraws the caller's own PENDING sourcing_requests (a direct
   *     guarded UPDATE — sourcing.ts's `applyGuardedTransition` isn't
   *     exported and is shaped for a single request + its conversation, not
   *     this bulk account-teardown; no counterparty follow-up message is
   *     inserted here for the same reason — see sourcing.ts's note next to
   *     `applyGuardedTransition`).
   *   - deletes the caller's push_tokens rows.
   *
   * The row itself is NEVER deleted here — the operator `purge-deleted-
   * accounts` CLI anonymizes (never row-deletes) accounts once `deleteAfter`
   * has passed, since orders/messages FK reference the user row.
   */
  deleteAccount: protectedProcedure
    .input(deleteAccountInput)
    .output(deleteAccountOutput)
    .mutation(async ({ input, ctx }) => {
      await requirePasswordMatch(ctx.db, ctx.auth, ctx.user.id, input.password);

      const now = new Date();
      const deleteAfter = new Date(now.getTime() + DELETE_GRACE_MS);
      const nonTerminalStatuses = [...TERMINAL_ORDER_STATUSES];

      const claimed = await ctx.db.transaction(async (tx) => {
        // Subquery builders — embedded via NOT EXISTS into the guarded UPDATE
        // below. They're never awaited/executed on their own; drizzle only
        // uses their generated SQL, so building them off `tx` keeps everything
        // scoped to this one transaction.
        const openOrderAsBuyer = tx
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.buyerId, ctx.user.id), notInArray(orders.status, nonTerminalStatuses)));

        const openOrderAsStoreOwner = tx
          .select({ id: orders.id })
          .from(orders)
          .innerJoin(stores, eq(orders.storeId, stores.id))
          .where(and(eq(stores.userId, ctx.user.id), notInArray(orders.status, nonTerminalStatuses)));

        const claim = await tx
          .update(users)
          .set({ deactivatedAt: now, deleteAfter })
          .where(
            and(
              eq(users.id, ctx.user.id),
              notExists(openOrderAsBuyer),
              notExists(openOrderAsStoreOwner),
            ),
          )
          .returning({ id: users.id });

        if (claim.length === 0) return claim;

        await tx
          .update(sourcingRequests)
          .set({ status: "withdrawn", updatedAt: now })
          .where(
            and(
              eq(sourcingRequests.createdByUserId, ctx.user.id),
              eq(sourcingRequests.status, "pending"),
            ),
          );

        await tx.delete(pushTokens).where(eq(pushTokens.userId, ctx.user.id));

        return claim;
      });

      if (claimed.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "You have orders in progress. Resolve them (fulfillment, cancellation, or refund) before deleting your account.",
        });
      }

      return { deleteAfter: deleteAfter.toISOString() };
    }),

  /**
   * Return the authenticated principal (fresh DB read).
   * Protected — requires a valid Bearer token.
   */
  me: protectedProcedure.output(sessionUser).query(async ({ ctx }) => {
    const [found] = await ctx.db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);

    if (!found) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not found",
      });
    }

    return {
      id: found.id,
      email: found.email,
      username: found.username,
    };
  }),
});
