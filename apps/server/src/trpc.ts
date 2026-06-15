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
