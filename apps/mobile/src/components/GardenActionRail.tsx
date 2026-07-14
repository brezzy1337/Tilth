/**
 * GardenActionRail — right-edge, vertically-stacked action rail for a garden
 * feed cell (F-053): like, comments, share. The established short-video idiom
 * (TikTok/Reels), rendered as an absolutely-positioned sibling over the media
 * in `GardenFeedScreen`'s per-cell wrapper — it does NOT live inside
 * `GardenPhotoCarousel`/`GardenVideoCell` so neither of those needs to change
 * shape; it just stacks on top, clear of `GardenPostOverlay`'s bottom-left
 * text block (which reserves right-hand space for it — see that file).
 *
 * Like — optimistic toggle w/ rollback:
 *   `toggleLike`'s mutation patches the SAME `garden.feed` infinite-query
 *   cache entry the feed screen reads from (`feedQueryInput`, passed down
 *   from `GardenFeedScreen`/`GardenFeedList` so the query key matches
 *   exactly), via the standard react-query onMutate/onError/onSuccess
 *   optimistic triad:
 *     - onMutate: cancel in-flight refetches, snapshot the previous cache,
 *       flip `likedByMe` + adjust `likeCount` immediately (no network wait).
 *     - onError: restore the snapshot (rollback).
 *     - onSuccess: patch again with the server's `{liked, likeCount}` (the
 *       source of truth), which also self-heals any race between rapid
 *       double-taps.
 *   This is deliberately NOT a plain invalidate — `toggleLike`'s response is
 *   documented (packages/shared) as sufficient to update the UI without a
 *   refetch, and an optimistic toggle is explicitly required for the tap to
 *   feel instant.
 *
 * Comments / share are presentational here — `onOpenComments` is owned by
 * `GardenFeedScreen` (a single comments sheet instance, not one per cell);
 * share uses React Native's built-in `Share` API directly (no new dep).
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { GardenFeedInput, GardenFeedItem } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { patchGardenFeedItem } from "../api/gardenFeedCache";
import { gardenShareUrl } from "../constants/urls";
import { colors, mediaScrim, spacing, type } from "../theme";

type Props = {
  item: GardenFeedItem;
  feedQueryInput: GardenFeedInput;
  onOpenComments: (postId: string, storeName: string) => void;
};

/** Compact count label: 999, 1.2k, 12k, 1.4m — keeps the rail's numbers short. */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}m`;
}

export function GardenActionRail({ item, feedQueryInput, onOpenComments }: Props) {
  const utils = trpc.useUtils();

  const toggleLike = trpc.garden.toggleLike.useMutation({
    onMutate: async ({ postId }) => {
      await utils.garden.feed.cancel(feedQueryInput);
      const previous = utils.garden.feed.getInfiniteData(feedQueryInput);

      utils.garden.feed.setInfiniteData(feedQueryInput, (old) =>
        patchGardenFeedItem(old, postId, (feedItem) => ({
          ...feedItem,
          likedByMe: !feedItem.likedByMe,
          likeCount: feedItem.likedByMe
            ? Math.max(0, feedItem.likeCount - 1)
            : feedItem.likeCount + 1,
        })),
      );

      return { previous };
    },
    // `isPending`-gated below, so at most one toggle is in flight per rail —
    // the snapshot this restores is always the one this exact mutation took.
    onError: (_err, _vars, context) => {
      if (context) utils.garden.feed.setInfiniteData(feedQueryInput, () => context.previous);
    },
    onSuccess: (data, { postId }) => {
      utils.garden.feed.setInfiniteData(feedQueryInput, (old) =>
        patchGardenFeedItem(old, postId, (feedItem) => ({
          ...feedItem,
          likedByMe: data.liked,
          likeCount: data.likeCount,
        })),
      );
    },
  });

  function handleToggleLike() {
    if (toggleLike.isPending) return;
    toggleLike.mutate({ postId: item.id });
  }

  function handleShare() {
    const url = gardenShareUrl(item.id);
    const message = `\u{1F331} ${item.storeName} on Tilth`;
    void Share.share(
      Platform.OS === "ios"
        ? { message, url }
        : // Android's share sheet has no separate `url` field — fold it into
          // the message so the link still travels with the share.
          { message: `${message}\n${url}` },
      { dialogTitle: message },
    );
  }

  return (
    <View style={styles.rail} pointerEvents="box-none">
      <Pressable
        style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
        onPress={handleToggleLike}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={item.likedByMe ? "Unlike this post" : "Like this post"}
        accessibilityState={{ selected: item.likedByMe }}
      >
        <Ionicons
          name={item.likedByMe ? "heart" : "heart-outline"}
          size={28}
          color={item.likedByMe ? colors.pop : colors.onPrimary}
          style={[styles.icon, toggleLike.isPending ? styles.iconPending : null]}
        />
        <Text style={styles.count}>{formatCount(item.likeCount)}</Text>
      </Pressable>

      <Pressable
        style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
        onPress={() => onOpenComments(item.id, item.storeName)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`View comments (${item.commentCount})`}
      >
        <Ionicons
          name="chatbubble-outline"
          size={28}
          color={colors.onPrimary}
          style={styles.icon}
        />
        <Text style={styles.count}>{formatCount(item.commentCount)}</Text>
      </Pressable>

      <Pressable
        style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
        onPress={handleShare}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Share this post"
      >
        <Ionicons
          name="arrow-redo-outline"
          size={28}
          color={colors.onPrimary}
          style={styles.icon}
        />
      </Pressable>
    </View>
  );
}

// Rail's own layout constants — `RAIL_WIDTH` below derives from these rather
// than duplicating a literal, so `GardenPostOverlay`'s caption clearance can
// never silently drift out of sync with the rail's actual footprint.
const RAIL_RIGHT_INSET = spacing.lg; // styles.rail.right
const ACTION_TOUCH_TARGET = 44; // styles.action.minWidth / minHeight (>=44pt tap target)
const RAIL_EDGE_BUFFER = 4; // breathing room so captions never hug the icons

/**
 * Total horizontal footprint of the rail from the screen's right edge: the
 * right inset it sits at, plus one action's touch-target width, plus a small
 * edge buffer. `GardenPostOverlay` imports this instead of maintaining its
 * own clearance literal.
 */
export const RAIL_WIDTH = RAIL_RIGHT_INSET + ACTION_TOUCH_TARGET + RAIL_EDGE_BUFFER; // 16+44+4=64

// Same dip Button.tsx uses for its `disabled` state (opacity 0.55) — reused
// here for both a pressed action and an in-flight like, so "this control
// isn't taking new input right now" always reads the same way.
const PRESSED_OPACITY = 0.55;

const styles = StyleSheet.create({
  rail: {
    position: "absolute",
    right: RAIL_RIGHT_INSET,
    bottom: spacing.xxl,
    alignItems: "center",
    gap: spacing.lg,
  },
  // Each action's touch target is >=44pt (icon 28 + vertical label + hitSlop
  // 10 on every edge comfortably clears the floor).
  action: {
    alignItems: "center",
    minWidth: ACTION_TOUCH_TARGET,
    minHeight: ACTION_TOUCH_TARGET,
    justifyContent: "center",
    gap: 2,
  },
  actionPressed: {
    opacity: PRESSED_OPACITY,
  },
  // Dims the heart while its toggle is in flight (same opacity as a pressed
  // action) so the in-flight state is visible even though the tap already
  // released.
  iconPending: {
    opacity: PRESSED_OPACITY,
  },
  // Drop shadow (not a translucent scrim box — the rail floats directly over
  // media with no backing panel) so icons/counts stay readable over bright
  // photos. Uses the same `mediaScrim` token as GardenPostOverlay's caption
  // scrim (see theme/index.ts) so both legibility treatments match exactly.
  icon: {
    textShadowColor: mediaScrim,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  count: {
    color: colors.onPrimary,
    fontSize: type.caption.fontSize - 1,
    fontWeight: "700",
    textShadowColor: mediaScrim,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
