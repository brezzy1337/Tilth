/**
 * tRPC initialisation — shared primitives used by all routers.
 *
 * Export `router`, `publicProcedure`, `protectedProcedure`, and
 * `createCallerFactory` from here; never re-call `initTRPC` elsewhere.
 */

import { TRPCError, initTRPC } from "@trpc/server";
import type { Context } from "./context";

const t = initTRPC.context<Context>().create();

/** Compose sub-routers into a parent router. */
export const router = t.router;

/** Procedure with no authentication requirement. */
export const publicProcedure = t.procedure;

/**
 * Procedure that requires an authenticated user.
 * Throws UNAUTHORIZED when `ctx.user` is null and narrows the user type to
 * non-null for downstream resolvers.
 *
 * F-051 gap (documented, not fixed here): auth is stateless — `ctx.user` is
 * populated purely from a verified JWT (`context.ts`'s `createContext`),
 * with NO per-request DB row lookup. That means a deactivated account's
 * (`auth.deleteAccount`) already-issued JWTs remain valid for their full
 * lifetime — deletion does NOT log the account out everywhere. Adding a
 * per-request DB hit here would fix that but costs a query on every
 * authenticated call; out of scope for v1. Deactivation is instead enforced
 * at the router surfaces that matter (see `helpers.ts`'s `activeUserClause`
 * / `isUserDeactivated`): a deactivated seller disappears from discovery and
 * can't be newly messaged, and `auth.login` itself rejects (or, within the
 * grace window, self-restores) a deactivated account.
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

/** Factory for building server-side callers (used in tests and SSR). */
export const createCallerFactory = t.createCallerFactory;
