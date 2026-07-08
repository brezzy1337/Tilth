/**
 * GardenPhotoCarousel — renders a `photo_set` garden feed cell.
 *
 * A horizontally-paged image carousel (dot indicators track the active
 * photo) with the shared GardenPostOverlay (caption / store / distance)
 * pinned to the bottom. Sized to fill its parent cell (full viewport height,
 * device width) by the caller.
 *
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import { Dimensions, FlatList, Image, StyleSheet, View, type NativeSyntheticEvent, type NativeScrollEvent } from "react-native";
import type { GardenFeedPhotoSetItem } from "@homegrown/shared";
import { GardenPostOverlay } from "./GardenPostOverlay";
import { colors } from "../theme";

const SCREEN_WIDTH = Dimensions.get("window").width;

type Props = {
  item: GardenFeedPhotoSetItem;
  height: number;
  onPressStore: () => void;
};

export function GardenPhotoCarousel({ item, height, onPressStore }: Props) {
  const [activePhoto, setActivePhoto] = useState(0);

  function handleMomentumScrollEnd(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setActivePhoto(index);
  }

  return (
    <View style={[styles.cell, { height }]}>
      <FlatList
        data={item.photos}
        keyExtractor={(photo, index) => `${photo.url}-${index}`}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        renderItem={({ item: photo }) => (
          <Image
            source={{ uri: photo.url }}
            style={[styles.photo, { width: SCREEN_WIDTH, height }]}
            resizeMode="cover"
          />
        )}
      />

      {item.photos.length > 1 ? (
        <View style={styles.dotRow} pointerEvents="none">
          {item.photos.map((_, index) => (
            <View
              key={index}
              style={[styles.dot, index === activePhoto ? styles.dotActive : null]}
            />
          ))}
        </View>
      ) : null}

      <GardenPostOverlay
        storeName={item.storeName}
        caption={item.caption}
        distanceKm={item.distanceKm}
        onPressStore={onPressStore}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  cell: {
    width: SCREEN_WIDTH,
    backgroundColor: "#000",
  },
  photo: {
    backgroundColor: "#000",
  },
  dotRow: {
    position: "absolute",
    top: 12,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.onPrimary,
    opacity: 0.5,
  },
  // Active dot stays white — a brand-green dot disappears against the leafy
  // produce photos this carousel exists to show.
  dotActive: {
    backgroundColor: colors.onPrimary,
    opacity: 1,
  },
});
