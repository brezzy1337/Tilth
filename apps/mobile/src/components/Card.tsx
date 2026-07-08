/**
 * Card — warm surface container. Rounded (radius lg), soft shadow by default
 * (`shadow="raised"` for floating overlays).
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
  /**
   * Shadow depth — "raised" for cards that float over other content (e.g. a
   * map overlay); defaults to the standard soft in-flow card shadow.
   */
  shadow?: "soft" | "raised";
  /** Disable the shadow entirely — useful when a card is nested inside another card. */
  flat?: boolean;
};

export function Card({
  children,
  variant = "surface",
  style,
  shadow = "soft",
  flat = false,
}: Props) {
  return (
    <View
      style={[
        styles.base,
        variant === "tint" ? styles.tint : styles.surface,
        flat ? null : shadows[shadow],
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
