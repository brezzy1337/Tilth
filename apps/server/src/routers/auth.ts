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
import { eq, or, and, count, notInArray } from "drizzle-orm";
import { publicProcedure, protectedProcedure, router } from "../trpc";
import { users, stores, orders, sourcingRequests, pushTokens } from "../db/schema";
import { TERMINAL_ORDER_STATUSES } from "../db/order-transitions";

/** F-051 — the soft-delete grace period; see `deleteAccount` below. */
const DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

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
      const [found] = await ctx.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);

      if (!found) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      }

      const valid = await ctx.auth.verifyPassword(input.currentPassword, found.passwordHash);
      if (!valid) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      }

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
   * On success, in one transaction:
   *   - withdraws the caller's own PENDING sourcing_requests (a direct
   *     guarded UPDATE — sourcing.ts's `applyGuardedTransition` isn't
   *     exported and is shaped for a single request + its conversation, not
   *     this bulk account-teardown; no counterparty follow-up message is
   *     inserted here for the same reason).
   *   - sets `deactivatedAt = now`, `deleteAfter = now + 30d` — this alone
   *     hides the caller's selling surfaces from discovery (see helpers.ts's
   *     `activeUserClause` / `isUserDeactivated`) and blocks new messages/
   *     sourcing requests TO them.
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
      const [found] = await ctx.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);

      if (!found) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      }

      const valid = await ctx.auth.verifyPassword(input.password, found.passwordHash);
      if (!valid) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      }

      const [callerStore] = await ctx.db
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.userId, ctx.user.id))
        .limit(1);

      const [buyerOpenOrders] = await ctx.db
        .select({ count: count() })
        .from(orders)
        .where(
          and(
            eq(orders.buyerId, ctx.user.id),
            notInArray(orders.status, [...TERMINAL_ORDER_STATUSES]),
          ),
        );

      let sellerOpenCount = 0;
      if (callerStore) {
        const [sellerOpenOrders] = await ctx.db
          .select({ count: count() })
          .from(orders)
          .where(
            and(
              eq(orders.storeId, callerStore.id),
              notInArray(orders.status, [...TERMINAL_ORDER_STATUSES]),
            ),
          );
        sellerOpenCount = sellerOpenOrders?.count ?? 0;
      }

      if ((buyerOpenOrders?.count ?? 0) > 0 || sellerOpenCount > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "You have orders in progress. Resolve them (fulfillment, cancellation, or refund) before deleting your account.",
        });
      }

      const now = new Date();
      const deleteAfter = new Date(now.getTime() + DELETE_GRACE_MS);

      await ctx.db.transaction(async (tx) => {
        await tx
          .update(sourcingRequests)
          .set({ status: "withdrawn", updatedAt: now })
          .where(
            and(
              eq(sourcingRequests.createdByUserId, ctx.user.id),
              eq(sourcingRequests.status, "pending"),
            ),
          );

        await tx
          .update(users)
          .set({ deactivatedAt: now, deleteAfter })
          .where(eq(users.id, ctx.user.id));

        await tx.delete(pushTokens).where(eq(pushTokens.userId, ctx.user.id));
      });

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
