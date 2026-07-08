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
import { Card } from "../components/Card";
import { colors, spacing, type } from "../theme";

export function LearnScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Card style={styles.card}>
          <Text style={styles.emoji}>{"\u{1F4DA}"}</Text>
          <Text style={styles.title}>Learn</Text>
          <Text style={styles.subtitle}>Coming soon.</Text>
          <Text style={styles.body}>
            Growing guides, seasonal tips, and seller resources will live here.
          </Text>
        </Card>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  card: {
    alignItems: "center",
    width: "100%",
  },
  emoji: {
    fontSize: 40,
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: type.title.fontSize,
    fontWeight: type.title.fontWeight,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: type.body.fontSize,
    fontWeight: "600",
    color: colors.primary,
    marginBottom: spacing.sm,
  },
  body: {
    fontSize: type.caption.fontSize + 1,
    color: colors.textMuted,
    textAlign: "center",
  },
});
