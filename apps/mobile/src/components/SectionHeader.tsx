/**
 * SectionHeader — an Ionicons glyph in a soft colored circle, next to a title
 * and optional subtitle. Used to open warm sections/cards (e.g. YourStand's
 * setup steps and dashboard blocks) instead of a bare uppercase label.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii, spacing, type } from "../theme";

type Props = {
  /** Ionicons glyph name. Provide exactly one of `icon` or `emoji`. */
  icon?: keyof typeof Ionicons.glyphMap;
  /** Emoji shown in the circle instead of an Ionicons glyph (e.g. product's locked "🌻"/"🌱" marks). */
  emoji?: string;
  title: string;
  subtitle?: string;
  /** Background tint for the icon circle. Defaults to primarySoft (terracotta tint). */
  tint?: string;
  /** Icon color (Ionicons only). Defaults to primary (terracotta). */
  iconColor?: string;
  /** "title" for a prominent page-level header (e.g. store name); "section" (default) for compact in-page headers. */
  size?: "title" | "section";
};

export function SectionHeader({
  icon,
  emoji,
  title,
  subtitle,
  tint = colors.primarySoft,
  iconColor = colors.primary,
  size = "section",
}: Props) {
  const isLarge = size === "title";
  return (
    <View style={styles.row}>
      <View style={[styles.iconCircle, isLarge ? styles.iconCircleLarge : null, { backgroundColor: tint }]}>
        {icon ? (
          <Ionicons name={icon} size={isLarge ? 22 : 18} color={iconColor} />
        ) : (
          <Text style={[styles.emoji, isLarge ? styles.emojiLarge : null]}>{emoji}</Text>
        )}
      </View>
      <View style={styles.textCol}>
        <Text style={isLarge ? styles.titleLarge : styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  iconCircleLarge: {
    width: 48,
    height: 48,
  },
  emoji: {
    fontSize: 18,
  },
  emojiLarge: {
    fontSize: 24,
  },
  textCol: {
    flex: 1,
  },
  title: {
    fontSize: type.section.fontSize,
    fontWeight: type.section.fontWeight,
    color: colors.text,
  },
  titleLarge: {
    fontSize: type.title.fontSize,
    fontWeight: type.title.fontWeight,
    color: colors.text,
  },
  subtitle: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginTop: 2,
  },
});
