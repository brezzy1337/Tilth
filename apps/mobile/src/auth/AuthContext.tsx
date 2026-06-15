/**
 * AuthContext — provides authentication state to the whole app.
 *
 * Status lifecycle:
 *   "loading"   → app just launched; restoring token from SecureStore
 *   "signedOut" → no valid token (never logged in, signed out, or token expired)
 *   "signedIn"  → token + user present and validated against auth.me
 *
 * Restore-on-launch (legacy bug fix §4/§7):
 *   On mount we read the stored token. If present we push it into the tRPC
 *   auth header and call auth.me with a one-shot vanilla tRPC client. Success
 *   lands us in signedIn; any error (401, network, expired) clears the token
 *   and lands us in signedOut. No token → signedOut immediately.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@homegrown/server";
import type { SessionUser } from "@homegrown/shared";
import { API_URL, setAuthToken } from "../api/trpc";
import { clearToken, getToken, saveToken } from "./tokenStore";

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

type AuthStatus = "loading" | "signedOut" | "signedIn";

interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  signIn: (token: string, user: SessionUser) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<SessionUser | null>(null);

  // Restore session on launch
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      try {
        const token = await getToken();
        if (!token) {
          if (!cancelled) setStatus("signedOut");
          return;
        }

        // Push token into the module-level holder so the one-shot client
        // below picks it up in its headers() function.
        setAuthToken(token);

        // Validate the token against the server with a one-shot vanilla client.
        const oneShot = createTRPCClient<AppRouter>({
          links: [
            httpBatchLink({
              url: `${API_URL}/trpc`,
              headers() {
                return { Authorization: `Bearer ${token}` };
              },
            }),
          ],
        });

        const me = await oneShot.auth.me.query();

        if (!cancelled) {
          setUser(me);
          setStatus("signedIn");
        }
      } catch {
        // Token missing, expired, or server rejected it — clear and sign out.
        setAuthToken(null);
        await clearToken().catch(() => {});
        if (!cancelled) setStatus("signedOut");
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (token: string, incoming: SessionUser) => {
    await saveToken(token);
    setAuthToken(token);
    setUser(incoming);
    setStatus("signedIn");
  }, []);

  const signOut = useCallback(async () => {
    await clearToken().catch(() => {});
    setAuthToken(null);
    setUser(null);
    setStatus("signedOut");
  }, []);

  return (
    <AuthContext.Provider value={{ status, user, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
