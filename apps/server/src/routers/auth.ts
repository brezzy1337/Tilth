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
} from "@homegrown/shared";
import { eq, or, and, notExists, notInArray } from "drizzle-orm";
import { publicProcedure, protectedProcedure, router } from "../trpc";
import { users, stores, orders, sourcingRequests, pushTokens } from "../db/schema";
import { TERMINAL_ORDER_STATUSES } from "../db/order-transitions";
import type { Db, AuthHelpers } from "../context";

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
   * still in the future) SELF-RESTORES the account (clears `deactivatedAt` /
   * `deleteAfter`) and proceeds as a normal login. Past the grace window (or
   * a malformed state — `deleteAfter` unset while `deactivatedAt` is set),
   * login is rejected with the SAME generic UNAUTHORIZED message as a wrong
   * password — an attacker probing usernames/emails must not be able to
   * distinguish "wrong password" from "this account was deleted".
   */
  login: publicProcedure
    .input(loginInput)
    .output(authResponse)
    .mutation(async ({ input, ctx }) => {
      const { usernameOrEmail, password } = input;

      // Look up by email OR username
      const [found] = await ctx.db
        .select({
          id: users.id,
          email: users.email,
          username: users.username,
          passwordHash: users.passwordHash,
          deactivatedAt: users.deactivatedAt,
          deleteAfter: users.deleteAfter,
        })
        .from(users)
        .where(
          or(
            eq(users.email, usernameOrEmail),
            eq(users.username, usernameOrEmail),
          ),
        )
        .limit(1);

      const INVALID_CREDS = new TRPCError({
        code: "UNAUTHORIZED",
        message: "Invalid credentials",
      });

      // Pre-existing, documented timing gap (not fixed here): the DB lookup
      // above and the hash verify below take measurably different time
      // depending on whether `found` exists (a real scrypt verify vs. none at
      // all), which is a timing side-channel for username/email enumeration.
      // Not addressed in this pass — see requirePasswordMatch's doc comment
      // for why `login` isn't wired through it.
      if (!found) throw INVALID_CREDS;

      const valid = await ctx.auth.verifyPassword(password, found.passwordHash);
      if (!valid) throw INVALID_CREDS;

      if (found.deactivatedAt) {
        const withinGrace = found.deleteAfter !== null && found.deleteAfter.getTime() > Date.now();
        if (!withinGrace) throw INVALID_CREDS;

        // Self-restore: clear both fields so every deactivation-gated
        // surface (helpers.ts's activeUserClause/isUserDeactivated) sees
        // this account as active again from this point on.
        await ctx.db
          .update(users)
          .set({ deactivatedAt: null, deleteAfter: null })
          .where(eq(users.id, found.id));
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
