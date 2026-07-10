/**
 * StallMarker — Home map pin for a grower's stall (F-042): shows up to 3
 * produce-category emoji (from the store's current listings) plus a compact
 * "+N" overflow count, so a buyer can tell what a stall sells before tapping
 * through to its storefront.
 *
 * Visually paired with `PlaceMarker` (F-048) but deliberately distinct at a
 * glance: PlaceMarker is a rounded-square badge (radii.sm) with a *type*-tint
 * border (accent/primary/secondary depending on place type) and reads "tap
 * for an info card, no storefront behind it". StallMarker instead uses a
 * pill badge (radii.pill) with a fixed `colors.primary` border — growers are
 * always the same "kind" of tap target (tap through to a store you can buy
 * from), so the border tint doesn't vary per-stall the way it does for
 * places; the pill shape (vs. place's rounded-square) is the other cue that
 * separates the two layers even before you register the border color.
 *
 * `tracksViewChanges={false}` for the same Android-perf reason as
 * PlaceMarker: a custom-view Marker re-rasterizes its bitmap on every render
 * while tracking is on. The category set only changes when the underlying
 * `listings.nearby` data changes (new/removed listing), so the caller must
 * key this component on `storeId` + the joined category string — see
 * HomeScreen's `storeMarkers` — to force a remount (and thus a fresh
 * rasterize) whenever that set changes, precedent set by PlaceMarker's
 * `id+type` key.
 *
 * `onPress` calls `event.stopPropagation()` before invoking the callback —
 * same Android bubbling reason as PlaceMarker (the MapView's own `onPress`
 * would otherwise fire too, e.g. clearing a selected place).
 */

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Marker, type MapMarkerProps } from "react-native-maps";
import { colors, radii, shadows, spacing } from "../theme";

const MAX_VISIBLE_CATEGORIES = 3;

type Props = {
  storeId: string;
  lat: number;
  lng: number;
  categoryEmojis: string[];
  onPress: () => void;
};

export function StallMarker({ lat, lng, categoryEmojis, onPress }: Props) {
  const visible = categoryEmojis.slice(0, MAX_VISIBLE_CATEGORIES);
  const overflow = categoryEmojis.length - visible.length;

  const handlePress: MapMarkerProps["onPress"] = (event) => {
    event.stopPropagation();
    onPress();
  };

  return (
    <Marker
      coordinate={{ latitude: lat, longitude: lng }}
      onPress={handlePress}
      tracksViewChanges={false}
      anchor={{ x: 0.5, y: 0.5 }}
    >
      <View style={styles.badge}>
        {visible.map((emoji, index) => (
          // Category set is deduped upstream (one entry per category), so
          // index is stable for the lifetime of this rasterized badge.
          <Text key={index} style={styles.emoji}>
            {emoji}
          </Text>
        ))}
        {overflow > 0 ? <Text style={styles.overflow}>{`+${overflow}`}</Text> : null}
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  badge: {
    // Pill shape (radii.pill) vs. PlaceMarker's rounded-square (radii.sm) is
    // the primary "different kind of pin" cue; fixed primary-green border
    // (vs. PlaceMarker's per-type tint) is the secondary cue.
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.primary,
    gap: 2,
    ...shadows.soft,
  },
  emoji: {
    fontSize: 16,
  },
  overflow: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.primary,
    marginLeft: 1,
  },
});
