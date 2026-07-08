/**
 * Expo push notification client — server-only.
 *
 * This file is the ONLY place in the router tree's dependency graph that
 * imports `expo-server-sdk`. Routers interact with push through the
 * `PushClient` interface defined in `context.ts`, so they stay SDK-free and
 * mobile-typecheck-safe (mirrors `stripe.ts` / `gcs.ts` / `mux.ts`).
 *
 * `EXPO_ACCESS_TOKEN` is OPTIONAL — Expo's push API works without one; the
 * token, when present, only raises rate limits. Never required at boot.
 *
 * `send` NEVER throws — a push delivery failure must not fail the caller's
 * mutation (e.g. `chat.send` must still succeed even if push delivery to the
 * other party fails). Invalid/unregistered tokens are filtered out via
 * `Expo.isExpoPushToken` before sending; any remaining per-chunk failure is
 * logged and swallowed.
 */

import { Expo } from "expo-server-sdk";
import type { PushClient } from "./context";

/**
 * Build a concrete `PushClient` backed by `expo-server-sdk`.
 *
 * @param accessToken - Optional Expo access token (from env, never hardcoded).
 *   Omit to send unauthenticated (still fully functional, lower rate limits).
 */
export function createExpoPushClient(accessToken?: string): PushClient {
  const expo = new Expo(accessToken ? { accessToken } : {});

  return {
    async send(input) {
      const validTokens = input.tokens.filter((token) => Expo.isExpoPushToken(token));
      if (validTokens.length === 0) return;

      const messages = validTokens.map((to) => ({
        to,
        title: input.title,
        body: input.body,
        data: input.data,
      }));

      const chunks = expo.chunkPushNotifications(messages);

      for (const chunk of chunks) {
        try {
          await expo.sendPushNotificationsAsync(chunk);
        } catch (err) {
          // Never let a push delivery failure propagate to the caller.
          console.error(
            "[push] sendPushNotificationsAsync failed",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    },
  };
}
