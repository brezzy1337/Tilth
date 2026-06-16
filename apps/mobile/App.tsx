/**
 * App.tsx — root component.
 *
 * Sets up:
 *   - AuthProvider (reads SecureStore, validates token, exposes auth state)
 *   - CartProvider (unconditional; lives inside AuthProvider so it can read
 *     auth status and clear the cart on sign-out)
 *   - QueryClientProvider (TanStack Query v5)
 *   - trpc.Provider (tRPC React Query bridge, single client with auth header)
 *   - StripeProvider (PaymentSheet + Connect onboarding redirect support)
 *   - React Navigation: pre-auth stack (Hero / LogIn / SignUp) or
 *     authenticated stack (Home, …), chosen by AuthContext status.
 *     While status === "loading" a centered splash is shown.
 *
 * Secrets policy: EXPO_PUBLIC_API_URL is read from the environment (set in
 * .env locally; never commit a filled-in .env). No secret keys here.
 * EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY is safe to expose to the client bundle
 * because it is a Stripe publishable key (pk_test_… / pk_live_…) — publishable
 * keys are designed for client use and carry no secret authority.
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
import { StripeProvider } from "@stripe/stripe-react-native";

import { trpc, API_URL, getAuthToken } from "./src/api/trpc";
import { AuthProvider, useAuth } from "./src/auth/AuthContext";
import { CartProvider } from "./src/cart/CartContext";
import { HeroScreen } from "./src/screens/HeroScreen";
import { LogInScreen } from "./src/screens/LogInScreen";
import { SignUpScreen } from "./src/screens/SignUpScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { YourStandScreen } from "./src/screens/YourStandScreen";
import { CartScreen } from "./src/screens/CartScreen";
import { OrdersScreen } from "./src/screens/OrdersScreen";
import { OrderDetailScreen } from "./src/screens/OrderDetailScreen";
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
            options={{ headerShown: false }}
          />
          <AuthedStack.Screen
            name="YourStand"
            component={YourStandScreen}
            options={{ title: "Your Stand" }}
          />
          <AuthedStack.Screen
            name="Cart"
            component={CartScreen}
            options={{ title: "Cart" }}
          />
          <AuthedStack.Screen
            name="Orders"
            component={OrdersScreen}
            options={{ title: "Orders" }}
          />
          <AuthedStack.Screen
            name="OrderDetail"
            component={OrderDetailScreen}
            options={{ title: "Order" }}
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
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {/* StripeProvider: publishable key is client-safe — it's a pk_test_…/pk_live_… key
            behind EXPO_PUBLIC_ by design. Secret/webhook keys remain server-only. */}
        <StripeProvider
          publishableKey={process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ""}
          urlScheme="homegrown"
        >
          <AuthProvider>
            {/* CartProvider is unconditional and lives inside AuthProvider so it
                can call useAuth() to clear items on sign-out, without being
                re-mounted on auth-state transitions. */}
            <CartProvider>
              <RootNavigator />
            </CartProvider>
          </AuthProvider>
        </StripeProvider>
      </QueryClientProvider>
    </trpc.Provider>
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
