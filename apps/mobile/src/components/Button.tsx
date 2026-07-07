/**
 * Button — warm themed button used across the "Harvest Warm" rollout.
 *
 * Variants:
 *   primary   — solid terracotta, white label (default)
 *   secondary — outlined terracotta, terracotta label
 *   ghost     — no border/fill, terracotta label (for low-emphasis actions)
 *
 * Full-width by default (matches the legacy button rows in YourStandScreen);
 * pass `fullWidth={false}` for inline/auto-sized buttons.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, radii, spacing, type } from "../theme";

type Variant = "primary" | "secondary" | "ghost";

type Props = {
  title: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Button({
  title,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  fullWidth = true,
  style,
}: Props) {
  const isDisabled = disabled || loading;
  const spinnerColor =
    variant === "primary" ? colors.onPrimary : colors.primary;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        fullWidth ? styles.fullWidth : null,
        variantStyles[variant],
        pressed && !isDisabled ? pressedVariantStyles[variant] : null,
        isDisabled ? styles.disabled : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={spinnerColor} />
      ) : (
        <Text style={[styles.label, variantLabelStyles[variant]]}>{title}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
  },
  fullWidth: {
    alignSelf: "stretch",
  },
  disabled: {
    opacity: 0.55,
  },
  label: {
    fontSize: type.body.fontSize,
    fontWeight: "700",
  },
});

const variantStyles = StyleSheet.create({
  primary: {
    backgroundColor: colors.primary,
  },
  secondary: {
    backgroundColor: "transparent",
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
  ghost: {
    backgroundColor: "transparent",
  },
});

const pressedVariantStyles = StyleSheet.create({
  primary: {
    backgroundColor: colors.primaryPressed,
  },
  secondary: {
    backgroundColor: colors.primarySoft,
  },
  ghost: {
    backgroundColor: colors.primarySoft,
  },
});

const variantLabelStyles = StyleSheet.create({
  primary: {
    color: colors.onPrimary,
  },
  secondary: {
    color: colors.primary,
  },
  ghost: {
    color: colors.primary,
  },
});
