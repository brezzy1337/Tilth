/**
 * App.tsx — root component.
 *
 * Sets up:
 *   - AuthProvider (reads SecureStore, validates token, exposes auth state)
 *   - QueryClientProvider (TanStack Query v5)
 *   - trpc.Provider (tRPC React Query bridge, single client with auth header)
 *   - React Navigation: pre-auth stack (Hero / LogIn / SignUp) or
 *     authenticated stack (Home, …), chosen by AuthContext status.
 *     While status === "loading" a centered splash is shown.
 *
 * Secrets policy: EXPO_PUBLIC_API_URL is read from the environment (set in
 * .env locally; never commit a filled-in .env). No secret keys here.
 */

import React, { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  View,
} from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { trpc, API_URL, getAuthToken } from "./src/api/trpc";
import { AuthProvider, useAuth } from "./src/auth/AuthContext";
import { HeroScreen } from "./src/screens/HeroScreen";
import { LogInScreen } from "./src/screens/LogInScreen";
import { SignUpScreen } from "./src/screens/SignUpScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import type {
  PreAuthStackParamList,
  AuthedStackParamList,
} from "./src/navigation/types";

const PreAuthStack = createNativeStackNavigator<PreAuthStackParamList>();
const AuthedStack = createNativeStackNavigator<AuthedStackParamList>();

// ---------------------------------------------------------------------------
// Inner component — reads auth status after providers are mounted
// ---------------------------------------------------------------------------

function RootNavigator() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#2d6a4f" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {status === "signedOut" ? (
        <PreAuthStack.Navigator initialRouteName="Hero">
          <PreAuthStack.Screen
            name="Hero"
            component={HeroScreen}
            options={{ headerShown: false }}
          />
          <PreAuthStack.Screen
            name="LogIn"
            component={LogInScreen}
            options={{ title: "Log In" }}
          />
          <PreAuthStack.Screen
            name="SignUp"
            component={SignUpScreen}
            options={{ title: "Sign Up" }}
          />
        </PreAuthStack.Navigator>
      ) : (
        <AuthedStack.Navigator>
          <AuthedStack.Screen
            name="Home"
            component={HomeScreen}
            options={{ title: "Home", headerBackVisible: false }}
          />
        </AuthedStack.Navigator>
      )}
    </NavigationContainer>
  );
}

// ---------------------------------------------------------------------------
// Root — providers first, then the navigator that reads from them
// ---------------------------------------------------------------------------

export default function App() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${API_URL}/trpc`,
          headers() {
            const token = getAuthToken();
            return token ? { Authorization: `Bearer ${token}` } : {};
          },
        }),
      ],
    }),
  );

  return (
    <AuthProvider>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <RootNavigator />
        </QueryClientProvider>
      </trpc.Provider>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
});
