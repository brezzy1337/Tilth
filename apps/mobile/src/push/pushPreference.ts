/**
 * pushPreference — persisted on/off flag for the Settings "Push notifications"
 * master toggle (F-051).
 *
 * The server has no notion of a per-user push preference (it only knows
 * whether a `push_tokens` row exists for the device) — whether the user has
 * ever actively turned push OFF isn't otherwise locally derivable, so it's
 * persisted on-device via expo-secure-store, same as the auth token
 * (`../auth/tokenStore.ts`) — the app's existing storage util for anything
 * that must survive a relaunch.
 *
 * Default (no stored value — fresh install, or an install predating F-051):
 * `true`, matching `usePushNotifications`'s original always-on behaviour so
 * existing installs keep receiving push until a user explicitly opts out.
 */

import * as SecureStore from "expo-secure-store";

const PUSH_PREFERENCE_KEY = "homegrown.push.enabled";

export async function getPushPreference(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(PUSH_PREFERENCE_KEY);
  return raw !== "false";
}

export async function setPushPreference(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(PUSH_PREFERENCE_KEY, enabled ? "true" : "false");
}
