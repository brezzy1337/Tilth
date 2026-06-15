/**
 * tRPC request context.
 *
 * `createContext` accepts injected deps (`db`, `jwtSecret`, and `auth`) so that
 * the router import tree never touches `./env`, `./db/index`, or `./auth` —
 * those modules have side-effects (env validation, DB connection, node:crypto)
 * that break mobile's typecheck and the env-free test invariant.
 *
 * The `db` type is expressed via Drizzle's `PostgresJsDatabase` + the schema
 * type, rather than `typeof db` from `./db/index`, to avoid following that
 * module's import chain into env.ts.
 *
 * Auth flow:
 *   1. Read the `Authorization: Bearer <token>` header.
 *   2. Verify via `deps.auth.verifyToken` (returns user id on success, null otherwise).
 *   3. Populate `ctx.user` with `{ id }` on success, else null.
 */

import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "./db/schema";

/**
 * Interface for password and token helpers.
 * Defined here (not in auth.ts) so routers can depend on the interface without
 * pulling in node:crypto types — which mobile's tsc cannot resolve.
 */
export interface AuthHelpers {
  hashPassword(plain: string): Promise<string>;
  verifyPassword(plain: string, stored: string): Promise<boolean>;
  signToken(userId: string, secret: string): Promise<string>;
  verifyToken(token: string, secret: string): Promise<string | null>;
}

/** The database type — Drizzle + our schema. */
export type Db = PostgresJsDatabase<typeof schema>;

/** Shape of the injected runtime dependencies. */
export interface ContextDeps {
  db: Db;
  jwtSecret: string;
  auth: AuthHelpers;
}

export async function createContext(
  { req }: CreateHTTPContextOptions,
  deps: ContextDeps,
) {
  const authHeader = req.headers.authorization;
  const token =
    authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let user: { id: string } | null = null;
  if (token) {
    const userId = await deps.auth.verifyToken(token, deps.jwtSecret);
    if (userId) {
      user = { id: userId };
    }
  }

  return {
    db: deps.db,
    jwtSecret: deps.jwtSecret,
    auth: deps.auth,
    user,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
