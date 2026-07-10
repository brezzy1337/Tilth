/**
 * PlaceMarker — Home map pin for a community place (F-048): a farmers
 * market, co-op, or health-food store. Rendered as a rounded-square badge
 * with a type emoji, deliberately distinct from `StallMarker` (F-042) — the
 * pill badge used for grower stores — a place pin must read as a different
 * kind of tap target at a glance (grower pin → tap through to a store you
 * can buy from; place pin → tap opens an info card, no storefront behind
 * it).
 *
 * `tracksViewChanges={false}` is required for Android perf: react-native-
 * maps re-rasterizes a custom-view Marker's bitmap on every render while
 * tracking is on, which tanks map FPS once more than a handful of pins are
 * on screen. The badge is fully static after mount (emoji/colors never
 * change), so there's no re-enable-then-disable dance needed here — tracking
 * can stay off from the first render.
 *
 * `onPress` calls `event.stopPropagation()` before invoking the callback —
 * on Android, react-native-maps otherwise bubbles the Marker tap up to the
 * MapView's own `onPress`, which HomeScreen wires to dismiss the info card.
 * Without stopping propagation, tapping a place pin would open the card and
 * immediately close it in the same gesture.
 */

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Marker, type MapMarkerProps } from "react-native-maps";
import type { CommunityPlace, CommunityPlaceType } from "@homegrown/shared";
import { colors, radii, shadows } from "../theme";

// 🎪 (circus tent) was the first pick for farmers_market but read circus-y
// against the Garden Fresh palette in review; 🧺 (basket) reads "market"
// without the carnival connotation. Tints stay in the "good" part of the
// palette (primary/accent/secondary) rather than `pop`, which is reserved
// for small danger-adjacent doses elsewhere (e.g. moderation UI) — a place
// pin shouldn't borrow that association.
const PLACE_TYPE_META: Record<CommunityPlaceType, { emoji: string; tint: string }> = {
  farmers_market: { emoji: "\u{1F9FA}", tint: colors.accent }, // 🧺
  coop: { emoji: "\u{1F6D2}", tint: colors.primary }, // 🛒
  health_food: { emoji: "\u{1F957}", tint: colors.secondary }, // 🥗
};

type Props = {
  place: CommunityPlace;
  onPress: () => void;
};

export function PlaceMarker({ place, onPress }: Props) {
  const meta = PLACE_TYPE_META[place.type];

  const handlePress: MapMarkerProps["onPress"] = (event) => {
    event.stopPropagation();
    onPress();
  };

  return (
    <Marker
      coordinate={{ latitude: place.lat, longitude: place.lng }}
      onPress={handlePress}
      tracksViewChanges={false}
      anchor={{ x: 0.5, y: 0.5 }}
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      accessibilityLabel={place.name}
    >
      <View style={[styles.badge, { borderColor: meta.tint }]}>
        <Text style={styles.emoji}>{meta.emoji}</Text>
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  badge: {
    // 36px circle-equivalent + 18px emoji — matches SectionHeader's badge
    // convention (borderWidth 2 stays: deliberate distinctness for map pins).
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.soft,
  },
  emoji: {
    fontSize: 18,
  },
});
