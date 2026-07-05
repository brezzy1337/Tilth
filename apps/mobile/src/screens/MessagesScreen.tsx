/**
 * MessagesScreen — placeholder for buyer/seller messaging (F-037).
 *
 * The real messaging feature (managed chat provider — TBD) has not landed
 * yet. This screen exists so the Messages tab has somewhere to land; it is
 * intentionally self-contained with no data fetching.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";

export function MessagesScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.title}>Messages</Text>
        <Text style={styles.subtitle}>Coming soon.</Text>
        <Text style={styles.body}>
          Chat with buyers and sellers about orders and listings will live
          here.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#fff",
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#2d6a4f",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#555",
    marginBottom: 12,
  },
  body: {
    fontSize: 14,
    color: "#888",
    textAlign: "center",
  },
});
