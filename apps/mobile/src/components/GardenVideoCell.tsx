/**
 * GardenVideoCell — renders a `video` garden feed cell (Mux-hosted HLS).
 *
 * Player lifecycle (Android decoder ceiling — at most 2-3 live players):
 *   - `isNear` (caller passes true for the visible cell +/- 1) controls
 *     whether a real player is created at all. When `isNear` is false the
 *     video source passed to `useVideoPlayer` is `null`, so
 *     `useReleasingSharedObject` (expo-video's internal hook) releases any
 *     previously-created native player for this cell — off-screen cells hold
 *     no decoder resources.
 *   - `isActive` (caller passes true only for the >=60%-visible cell from
 *     onViewableItemsChanged) controls play/pause — only one cell plays audio
 *     at a time.
 *   - Starts muted; tapping the cell toggles mute.
 *   - The Mux poster image covers the player until playback actually starts
 *     (tracked via the player's `playingChange` event), so there's no flash
 *     of a black surface while HLS is buffering.
 *
 * React Native only — no DOM elements.
 */

import React, { useEffect, useState } from "react";
import { Dimensions, Image, Pressable, StyleSheet, View } from "react-native";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import type { GardenFeedVideoItem } from "@homegrown/shared";
import { GardenPostOverlay } from "./GardenPostOverlay";

const SCREEN_WIDTH = Dimensions.get("window").width;

type Props = {
  item: GardenFeedVideoItem;
  height: number;
  isActive: boolean;
  isNear: boolean;
  onPressStore: () => void;
};

export function GardenVideoCell({ item, height, isActive, isNear, onPressStore }: Props) {
  const [muted, setMuted] = useState(true);
  const source = isNear ? { uri: `https://stream.mux.com/${item.muxPlaybackId}.m3u8` } : null;

  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = true;
  });

  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });

  useEffect(() => {
    player.muted = muted;
  }, [player, muted]);

  useEffect(() => {
    if (isNear && isActive) {
      player.play();
    } else {
      player.pause();
    }
  }, [player, isNear, isActive]);

  return (
    <View style={[styles.cell, { height }]}>
      {isNear ? (
        <Pressable style={styles.fill} onPress={() => setMuted((m) => !m)}>
          <VideoView
            style={styles.fill}
            player={player}
            nativeControls={false}
            contentFit="cover"
          />
        </Pressable>
      ) : null}

      {!isNear || !isPlaying ? (
        <Image
          source={{ uri: item.posterUrl }}
          style={[StyleSheet.absoluteFill, styles.poster]}
          resizeMode="cover"
        />
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
  fill: {
    flex: 1,
  },
  poster: {
    backgroundColor: "#000",
  },
});
