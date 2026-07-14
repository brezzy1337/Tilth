/**
 * "Garden Fresh" theme tokens (palette round 2 — Devin picked this over the
 * terracotta-led "Harvest Warm" v1; green leads, tomato + sunflower accent).
 *
 * Plain typed consts — no React context/provider. Screens import tokens
 * directly (e.g. `import { colors, spacing } from "../theme"`). Dark mode is
 * out of scope; there is exactly one palette.
 *
 * This module (plus categoryEmoji.ts) is the pilot rollout for F-044. Only
 * YourStandScreen + a few shared primitives consume it so far — other
 * screens keep their existing inline styles until Devin approves on-device
 * and the rollout phase restyles the rest of the app.
 */

import { StyleSheet } from "react-native";

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export const colors = {
  // Backgrounds
  bg: "#FBF8F2",
  surface: "#FFFFFF",
  surfaceAlt: "#F4F0E5",

  // Primary — fresh green (livelier than the old #2d6a4f)
  primary: "#3A8A5F",
  primaryPressed: "#2E6E4C",
  primarySoft: "#E1F0E7",

  // Secondary — deep market green (success/growth; near-primary on purpose so
  // success states read as "green = good" while primary stays the action color)
  secondary: "#2E7A50",
  secondarySoft: "#E1F0E7",

  // Accent — sunflower yellow (badges, highlights)
  accent: "#F2B705",
  accentSoft: "#FDF3D0",

  // Pop — tomato red: small doses only (never full buttons; too close to danger)
  pop: "#E35B4F",
  popSoft: "#FBE5E2",

  // Text
  text: "#263A30",
  textMuted: "#7C8377",
  border: "#E5E0D3",

  // Danger — warm red. `dangerPressed` follows the same ~20%-darken-per-
  // channel derivation as `primaryPressed` above (192,57,43 * 0.8 ≈ 154,46,34)
  // so solid-danger buttons (delete account, report message) get the same
  // pressed-state feedback solid-primary buttons do.
  danger: "#C0392B",
  dangerPressed: "#9A2E22",
  dangerSoft: "#F9E4E1",

  // Fixed white for text on solid-color buttons/badges
  onPrimary: "#FFFFFF",
} as const;

// ---------------------------------------------------------------------------
// Spacing scale
// ---------------------------------------------------------------------------

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

// ---------------------------------------------------------------------------
// Radii
// ---------------------------------------------------------------------------

export const radii = {
  sm: 8,
  md: 14,
  lg: 20,
  pill: 999,
} as const;

// ---------------------------------------------------------------------------
// Shadows — soft, low-opacity, warm-neutral. Spread with StyleSheet.flatten
// or directly in a style array: `[styles.card, shadows.soft]`.
// ---------------------------------------------------------------------------

export const shadows = {
  soft: StyleSheet.create({
    shadow: {
      shadowColor: "#263A30",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 8,
      elevation: 2,
    },
  }).shadow,
  raised: StyleSheet.create({
    shadow: {
      shadowColor: "#263A30",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 14,
      elevation: 4,
    },
  }).shadow,
} as const;

// ---------------------------------------------------------------------------
// Media legibility — the single value for text-legibility-over-media (garden
// feed cells, F-053): used both as GardenPostOverlay's caption scrim and as
// GardenActionRail's icon/count text-shadow color, so a caption sitting on a
// scrim and a rail icon floating with just a shadow read as the same
// "readable over any photo/video" treatment rather than two independently
// tuned values that happen to look similar.
// ---------------------------------------------------------------------------

export const mediaScrim = "rgba(0,0,0,0.35)";

// ---------------------------------------------------------------------------
// Type presets — font-size/weight pairs. Components apply `color` themselves
// (usually `colors.text` or `colors.textMuted`) since the right color varies
// by context.
// ---------------------------------------------------------------------------

export const type = {
  display: { fontSize: 28, fontWeight: "700" as const },
  title: { fontSize: 22, fontWeight: "700" as const },
  section: { fontSize: 17, fontWeight: "700" as const },
  body: { fontSize: 15, fontWeight: "400" as const },
  caption: { fontSize: 13, fontWeight: "400" as const },
  label: { fontSize: 13, fontWeight: "600" as const },
} as const;
