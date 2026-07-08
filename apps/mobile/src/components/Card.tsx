/**
 * Card — warm surface container. Rounded (radius lg), soft shadow.
 *
 * `variant="tint"` uses the subtle surfaceAlt background instead of plain
 * surface white — useful for nested/secondary cards (e.g. a collapsed step
 * summary) that shouldn't compete with the primary card on a screen.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { colors, radii, shadows, spacing } from "../theme";

type Props = {
  children: React.ReactNode;
  variant?: "surface" | "tint";
  style?: StyleProp<ViewStyle>;
  /** Disable the soft shadow — useful when a card is nested inside another card. */
  flat?: boolean;
};

export function Card({ children, variant = "surface", style, flat = false }: Props) {
  return (
    <View
      style={[
        styles.base,
        variant === "tint" ? styles.tint : styles.surface,
        flat ? null : shadows.soft,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  surface: {
    backgroundColor: colors.surface,
  },
  tint: {
    backgroundColor: colors.surfaceAlt,
  },
});
