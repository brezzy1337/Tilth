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
  scrim: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 40,
    paddingBottom: 24,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  textBlock: {
    gap: 4,
  },
  storeName: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  distance: {
    color: "#e8eae8",
    fontSize: 13,
    fontWeight: "500",
  },
  caption: {
    color: "#f7f9f7",
    fontSize: 14,
  },
});
