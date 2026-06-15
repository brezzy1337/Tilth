/**
 * tokenStore — thin wrappers over expo-secure-store for the JWT bearer token.
 *
 * Secrets policy: the token is stored on-device in SecureStore, never in JS
 * bundle, env vars, or AsyncStorage. The key is a non-secret constant.
 */

import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "homegrown.auth.token";

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
