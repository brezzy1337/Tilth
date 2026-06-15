/**
 * Typed tRPC client for HomeGrown mobile.
 *
 * AppRouter is imported type-only from @homegrown/server — no runtime import.
 * The server package's `exports` maps the `types` condition to src/router.ts.
 *
 * EXPO_PUBLIC_API_URL is set in .env (gitignored). Never put secrets here —
 * only the API base URL, which is not a secret.
 *
 * Auth header: call setAuthToken(token) after sign-in and setAuthToken(null)
 * after sign-out. The httpBatchLink headers() function reads the current value
 * so every subsequent request carries the correct Bearer token.
 */

import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@homegrown/server";

export const trpc = createTRPCReact<AppRouter>();

export const API_URL =
  process.env["EXPO_PUBLIC_API_URL"] ?? "http://localhost:3001";

// ---------------------------------------------------------------------------
// Module-level token holder — updated by AuthContext on sign-in / sign-out.
// The single tRPC client instance reads this on every request so it always
// sends the latest token without needing to be recreated.
// ---------------------------------------------------------------------------

let _authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  _authToken = token;
}

export function getAuthToken(): string | null {
  return _authToken;
}
