/**
 * HomeScreen — main authenticated screen.
 *
 * Shows:
 *   - Personalised greeting using the signed-in user's username
 *   - API status card (trpc.health.ping) to prove the typed end-to-end chain
 *   - Sign Out button (calls auth.signOut() → returns to pre-auth stack via
 *     the AuthContext gate in App.tsx)
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";

export function HomeScreen() {
  const { data, isLoading, error } = trpc.health.ping.useQuery();
  const { user, signOut } = useAuth();

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {/* Greeting */}
        <Text style={styles.title}>HomeGrown</Text>
        {user ? (
          <Text style={styles.greeting}>Welcome, {user.username}!</Text>
        ) : null}

        {/* API status card */}
        <View style={styles.statusCard}>
          <Text style={styles.cardLabel}>API Status</Text>

          {isLoading && <ActivityIndicator size="small" color="#2d6a4f" />}

          {error && (
            <Text style={styles.errorText}>
              Could not reach server: {error.message}
            </Text>
          )}

          {data && (
            <>
              <Text style={styles.statusValue}>
                Status: <Text style={styles.statusOk}>{data.status}</Text>
              </Text>
              <Text style={styles.statusValue}>Service: {data.service}</Text>
            </>
          )}
        </View>

        {/* Sign out */}
        <Pressable style={styles.signOutButton} onPress={() => void signOut()}>
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f7f9f7",
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#2d6a4f",
  },
  greeting: {
    fontSize: 16,
    color: "#555",
  },
  statusCard: {
    width: "100%",
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
    gap: 8,
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#999",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  statusValue: {
    fontSize: 15,
    color: "#333",
  },
  statusOk: {
    color: "#2d6a4f",
    fontWeight: "600",
  },
  errorText: {
    fontSize: 14,
    color: "#c0392b",
  },
  signOutButton: {
    borderWidth: 2,
    borderColor: "#2d6a4f",
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 8,
  },
  signOutText: {
    color: "#2d6a4f",
    fontSize: 15,
    fontWeight: "600",
  },
});
