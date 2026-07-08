/**
 * HeroScreen — initial landing screen (pre-auth).
 * Navigates to LogIn or SignUp; never directly to Home
 * (the navigation gate in App.tsx handles that after sign-in).
 *
 * Restyled to "Garden Fresh" tokens (F-044) — warm bg, Card-wrapped CTA
 * block, Button primitives, a touch of produce-emoji personality.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { PreAuthStackParamList } from "../navigation/types";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { colors, spacing, type } from "../theme";

type Props = NativeStackScreenProps<PreAuthStackParamList, "Hero">;

export function HeroScreen({ navigation }: Props) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.emoji}>{"\u{1F331}"}</Text>
        <Text style={styles.title}>Tilth</Text>
        <Text style={styles.subtitle}>Local food, straight from the source.</Text>

        <Card style={styles.card}>
          <View style={styles.buttonRow}>
            <Button title="Log In" onPress={() => navigation.navigate("LogIn")} />
            <Button
              title="Sign Up"
              variant="secondary"
              onPress={() => navigation.navigate("SignUp")}
            />
          </View>
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
    paddingHorizontal: spacing.xxl,
  },
  emoji: {
    fontSize: 48,
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: type.display.fontSize,
    fontWeight: type.display.fontWeight,
    color: colors.primary,
    marginBottom: spacing.sm,
  },
  subtitle: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
    marginBottom: spacing.xxxl,
    textAlign: "center",
  },
  card: {
    width: "100%",
  },
  buttonRow: {
    width: "100%",
    gap: spacing.md,
  },
});
