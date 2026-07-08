/**
 * ColorBadge — primitive rounded-pill badge used by StatusPill and refund states.
 *
 * Accepts explicit `bg` and `text` colours so every caller owns its own palette
 * without duplicating View/Text layout code. Restyled to "Garden Fresh" tokens
 * (F-044) — pill radius token, spacing tokens. Callers own the bg/text hues
 * (see StatusPill's STATUS_CONFIG for the status→token colour mapping).
 */

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { radii, spacing } from "../theme";

interface ColorBadgeProps {
  label: string;
  bg: string;
  text: string;
}

export function ColorBadge({ label, bg, text }: ColorBadgeProps) {
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingVertical: spacing.xs - 1,
    paddingHorizontal: spacing.md - 2,
    borderRadius: radii.pill,
    alignSelf: "flex-start",
  },
  pillText: {
    fontSize: 12,
    fontWeight: "600",
  },
});
