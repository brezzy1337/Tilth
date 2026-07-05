/**
 * LearnScreen — placeholder for buyer/seller education content (F-040).
 *
 * Growing guides, seasonal tips, and seller onboarding help will land here.
 * This screen exists so the Learn tab has somewhere to land; it is
 * intentionally self-contained with no data fetching.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";

export function LearnScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.title}>Learn</Text>
        <Text style={styles.subtitle}>Coming soon.</Text>
        <Text style={styles.body}>
          Growing guides, seasonal tips, and seller resources will live here.
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
