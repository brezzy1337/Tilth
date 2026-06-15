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
import {
  authResponse,
  loginInput,
  registerInput,
  sessionUser,
} from "@homegrown/shared";
import { eq, or } from "drizzle-orm";
import { publicProcedure, protectedProcedure, router } from "../trpc";
import { users } from "../db/schema";

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

      const [newUser] = await ctx.db
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
