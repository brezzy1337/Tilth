/**
 * GardenPostOverlay — shared bottom-left scrim overlay for a garden feed cell.
 *
 * Rendered on top of both photo_set carousel cells and video cells so the
 * caption / store name / distance treatment stays identical across post
 * types. Store name is tappable when onPressStore is provided (navigates to
 * StoreProfile — the storeId lives on every feed item).
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, spacing, type } from "../theme";

type Props = {
  storeName: string;
  caption: string;
  distanceKm: number;
  onPressStore: () => void;
};

export function GardenPostOverlay({ storeName, caption, distanceKm, onPressStore }: Props) {
  return (
    <View style={styles.scrim} pointerEvents="box-none">
      <View style={styles.textBlock} pointerEvents="box-none">
        <Pressable onPress={onPressStore} hitSlop={8}>
          <Text style={styles.storeName}>
            {storeName} <Text style={styles.distance}>· {distanceKm.toFixed(1)} km</Text>
          </Text>
        </Pressable>
        {caption.trim().length > 0 ? (
          <Text style={styles.caption} numberOfLines={3}>
            {caption}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Scrim stays a neutral dark overlay (readability over arbitrary media),
  // independent of the warm palette; only the text colors below are tokened.
  scrim: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: 40,
    paddingBottom: spacing.xxl,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  textBlock: {
    gap: spacing.xs,
  },
  storeName: {
    color: colors.onPrimary,
    fontSize: type.body.fontSize + 1,
    fontWeight: "700",
  },
  distance: {
    color: colors.onPrimary,
    opacity: 0.85,
    fontSize: type.caption.fontSize,
    fontWeight: "500",
  },
  caption: {
    color: colors.onPrimary,
    opacity: 0.95,
    fontSize: type.body.fontSize,
  },
});
