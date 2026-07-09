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
 *   - Push notifications (F-037): once signed in, usePushNotifications
 *     registers the device's Expo push token (best-effort — a simulator,
 *     denied permission, or network failure never blocks app start) and
 *     deep-links notification taps carrying data.conversationId into the
 *     Conversation screen via navigationRef.
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
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { StripeProvider } from "@stripe/stripe-react-native";

import { trpc, API_URL, getAuthToken } from "./src/api/trpc";
import { colors } from "./src/theme";
import { AuthProvider, useAuth } from "./src/auth/AuthContext";
import { CartProvider } from "./src/cart/CartContext";
import { usePushNotifications } from "./src/push/pushNotifications";
import {
  navigationRef,
  flushPendingConversationNavigation,
} from "./src/navigation/rootNavigation";
import { HeroScreen } from "./src/screens/HeroScreen";
import { LogInScreen } from "./src/screens/LogInScreen";
import { SignUpScreen } from "./src/screens/SignUpScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { SearchScreen } from "./src/screens/SearchScreen";
import { GardenFeedScreen } from "./src/screens/GardenFeedScreen";
import { GardenComposerScreen } from "./src/screens/GardenComposerScreen";
import { YourStandScreen } from "./src/screens/YourStandScreen";
import { MessagesScreen } from "./src/screens/MessagesScreen";
import { LearnScreen } from "./src/screens/LearnScreen";
import { CartScreen } from "./src/screens/CartScreen";
import { OrdersScreen } from "./src/screens/OrdersScreen";
import { OrderDetailScreen } from "./src/screens/OrderDetailScreen";
import { StoreOrdersScreen } from "./src/screens/StoreOrdersScreen";
import { StoreProfileScreen } from "./src/screens/StoreProfileScreen";
import { ConversationScreen } from "./src/screens/ConversationScreen";
import { SourcingScreen } from "./src/screens/SourcingScreen";
import { SourcingComposeScreen } from "./src/screens/SourcingComposeScreen";
import type {
  PreAuthStackParamList,
  AuthedStackParamList,
  TabParamList,
} from "./src/navigation/types";

const PreAuthStack = createNativeStackNavigator<PreAuthStackParamList>();
const AuthedStack = createNativeStackNavigator<AuthedStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

// ---------------------------------------------------------------------------
// MainTabs — the 5-tab bottom navigation bar (Home, Gardens, Sell, Messages,
// Learn). Gardens (F-047) took Search's former tab slot; SearchScreen is
// still reachable, pushed above the tabs from the root AuthedStack (Home's
// seasonal chips deep-link into it via navigate("Search", { initialQuery })).
// Detail/flow screens (Cart, Orders, OrderDetail, StoreOrders, StoreProfile,
// Search, GardenComposer) are NOT tabs — they're pushed above this navigator
// from the root AuthedStack.
// ---------------------------------------------------------------------------

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          headerShown: false,
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "home" : "home-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Gardens"
        component={GardenFeedScreen}
        options={{
          headerShown: false,
          title: "Gardens",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "flower" : "flower-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Sell"
        component={YourStandScreen}
        options={{
          title: "Your Stand",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "leaf" : "leaf-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Messages"
        component={MessagesScreen}
        options={{
          title: "Messages",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? "chatbubbles" : "chatbubbles-outline"}
              size={size}
              color={color}
            />
          ),
        }}
      />
      <Tab.Screen
        name="Learn"
        component={LearnScreen}
        options={{
          title: "Learn",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "book" : "book-outline"} size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

// ---------------------------------------------------------------------------
// Inner component — reads auth status after providers are mounted
// ---------------------------------------------------------------------------

function RootNavigator() {
  const { status } = useAuth();

  // Push token registration + notification-tap deep links; armed once auth
  // resolves to signedIn. Internally failure-tolerant (see pushNotifications.ts).
  usePushNotifications(status === "signedIn");

  if (status === "loading") {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef} onReady={flushPendingConversationNavigation}>
      {status === "signedOut" ? (
        <PreAuthStack.Navigator
          initialRouteName="Hero"
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.primary,
            headerTitleStyle: { color: colors.text },
          }}
        >
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
        <AuthedStack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: colors.surface },
            headerTintColor: colors.primary,
            headerTitleStyle: { color: colors.text },
          }}
        >
          <AuthedStack.Screen
            name="MainTabs"
            component={MainTabs}
            options={{ headerShown: false }}
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
          <AuthedStack.Screen
            name="StoreOrders"
            component={StoreOrdersScreen}
            options={{ title: "Your Orders" }}
          />
          <AuthedStack.Screen
            name="StoreProfile"
            component={StoreProfileScreen}
            options={{ title: "Stand" }}
          />
          <AuthedStack.Screen
            name="Search"
            component={SearchScreen}
            options={{ title: "Search" }}
          />
          <AuthedStack.Screen
            name="Conversation"
            component={ConversationScreen}
            options={{ title: "Conversation" }}
          />
          <AuthedStack.Screen
            name="GardenComposer"
            component={GardenComposerScreen}
            options={{ title: "New Garden Post", presentation: "modal" }}
          />
          <AuthedStack.Screen
            name="Sourcing"
            component={SourcingScreen}
            options={{ title: "Sourcing" }}
          />
          <AuthedStack.Screen
            name="SourcingCompose"
            component={SourcingComposeScreen}
            options={{ title: "New Request", presentation: "modal" }}
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
    <GestureHandlerRootView style={styles.gestureRoot}>
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
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
  },
  splash: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
});
