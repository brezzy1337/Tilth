/**
 * ColorBadge — primitive rounded-pill badge used by StatusPill and refund states.
 *
 * Accepts explicit `bg` and `text` colours so every caller owns its own palette
 * without duplicating View/Text layout code.
 */

import React from "react";
import { StyleSheet, Text, View } from "react-native";

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
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 12,
    alignSelf: "flex-start",
  },
  pillText: {
    fontSize: 12,
    fontWeight: "600",
  },
});
