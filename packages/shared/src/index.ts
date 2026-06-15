/**
 * @homegrown/shared — single source of truth for every contract shared between
 * apps/server and apps/mobile. Both apps import zod schemas, inferred types, and
 * enums from this package; they never duplicate a shape locally.
 *
 * Note: `AppRouter` intentionally lives in `apps/server` (where tRPC routers
 * compose). Mobile imports it type-only from there to avoid a circular dependency.
 * This package holds everything else the two apps agree on.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Health-check response
// Returned by the server's health endpoint; rendered by mobile's status screen.
// ---------------------------------------------------------------------------

export const healthResponse = z.object({
  /** Always "ok" — any non-200 HTTP status means the server is not healthy. */
  status: z.literal("ok"),
  /** Human-readable service name, e.g. "homegrown-api". */
  service: z.string(),
  /** Seconds the process has been running; never negative. */
  uptimeSeconds: z.number().nonnegative(),
  /** ISO 8601 timestamp of when this response was generated. */
  timestamp: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponse>;

// ---------------------------------------------------------------------------
// Auth — register, login, session principal, and auth response
// Shared between the server router (validation) and mobile screens (forms).
// IMPORTANT: SessionUser intentionally omits password/hash — it is the safe
// public principal returned in tokens and stored in client state.
// ---------------------------------------------------------------------------

/** Input to `auth.register`. Username restricted to letters, digits, underscore. */
export const registerInput = z.object({
  email: z.string().email(),
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, "Username may only contain letters, digits, and underscores"),
  password: z.string().min(8).max(100),
});

export type RegisterInput = z.infer<typeof registerInput>;

/** Input to `auth.login`. Accepts either a username or an email as the first field. */
export const loginInput = z.object({
  usernameOrEmail: z.string().min(1),
  password: z.string().min(1),
});

export type LoginInput = z.infer<typeof loginInput>;

/**
 * Safe public principal — the subset of user fields that may leave the server.
 * Never includes a password, password hash, or any other credential.
 */
export const sessionUser = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  username: z.string(),
});

export type SessionUser = z.infer<typeof sessionUser>;

/**
 * Response returned by `auth.register` and `auth.login`.
 * `token` is a Bearer token the mobile app persists in Expo SecureStore and
 * sends as an `Authorization` header on subsequent requests.
 */
export const authResponse = z.object({
  token: z.string(),
  user: sessionUser,
});

export type AuthResponse = z.infer<typeof authResponse>;

// ---------------------------------------------------------------------------
// Stores — create, get, and public store profile
// Matches the `stores` entity in §2.1: one store per user for the pilot.
// ---------------------------------------------------------------------------

/** Input to `stores.create` (protected). Server infers `userId` from the session. */
export const createStoreInput = z.object({
  name: z.string().min(1).max(120),
  logo: z.string().url().nullish(),
  about: z.string().max(2000).nullish(),
});

export type CreateStoreInput = z.infer<typeof createStoreInput>;

/** Input to `stores.get` (public). Returns the public store profile. */
export const getStoreInput = z.object({
  storeId: z.string().uuid(),
});

export type GetStoreInput = z.infer<typeof getStoreInput>;

/**
 * Public store profile returned by `stores.get` and `stores.getMine`.
 * `stripeConnectAccountId` is included so the mobile client can detect whether
 * the seller has completed Connect Express onboarding, but it carries no secret
 * (the account ID is not a credential).
 */
export const store = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string(),
  logo: z.string().nullable(),
  about: z.string().nullable(),
  stripeConnectAccountId: z.string().nullable(),
});

export type Store = z.infer<typeof store>;
