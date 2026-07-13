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
 * with NO per-request DB row lookup here in the middleware itself. That
 * means a deactivated account's (`auth.deleteAccount`) already-issued JWTs
 * remain valid for their full lifetime — deletion does NOT log the account
 * out everywhere, and a deactivated caller can still hit any procedure that
 * doesn't explicitly guard against it (see below). Adding a per-request DB
 * hit HERE would close that gap but costs a query on every authenticated
 * call regardless of whether the procedure even needs it; out of scope for
 * v1. Deactivation is instead enforced per-procedure, at the specific
 * surfaces that matter, in BOTH directions (see helpers.ts's deactivation
 * section for the full picture):
 *
 *   - COUNTERPARTY direction — `helpers.ts`'s `activeUserClause` /
 *     `isUserDeactivated` / `resolveActiveStore` hide a deactivated
 *     seller/place-owner from discovery (`listings.nearby`,
 *     `sourcing.growers`, `garden.feed`, `places.nearby`) and block NEW
 *     writes that would notify them (`stores.get`, `chat.start`/`send`,
 *     `sourcing.createRequest`/`createOffer`/`respond`, `orders.create`'s
 *     target-store check). `auth.login` itself rejects (or, within the
 *     grace window, self-restores) a deactivated account.
 *   - CALLER direction — `helpers.ts`'s `assertCallerActive` (UNAUTHORIZED)
 *     is called at the top of every write a deactivated account must not be
 *     able to perform: `orders.create`, `chat.start`/`send`,
 *     `sourcing.createRequest`/`createOffer`/`respond`/`withdraw`,
 *     `garden.createPhotoSet`/`createPhotoUploadUrls`/`createVideo`. Reads
 *     are deliberately NOT guarded this way — a deactivated caller can still
 *     browse/read; only writes on this list are blocked.
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
