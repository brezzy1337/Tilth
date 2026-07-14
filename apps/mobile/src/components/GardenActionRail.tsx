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
import type { GardenFeedInput, GardenFeedItem, GardenFeedOutput } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { gardenShareUrl } from "../constants/urls";
import { colors, spacing, type } from "../theme";

// `pageParams` is typed to match `garden.feed`'s cursor exactly (its
// `nextCursor` field, which doubles as the next page's param, is
// `string | null`) — react-query's InfiniteData<T, TPageParam> otherwise
// rejects a widened `unknown[]` when handed back via setInfiniteData.
type InfiniteFeedData = { pages: GardenFeedOutput[]; pageParams: (string | null)[] };

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

/** Patch a single feed item across every cached page, leaving everything else untouched. */
function patchFeedItem(
  data: InfiniteFeedData | undefined,
  postId: string,
  patch: (item: GardenFeedItem) => GardenFeedItem,
): InfiniteFeedData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.id === postId ? patch(item) : item)),
    })),
  };
}

export function GardenActionRail({ item, feedQueryInput, onOpenComments }: Props) {
  const utils = trpc.useUtils();

  const toggleLike = trpc.garden.toggleLike.useMutation({
    onMutate: async ({ postId }) => {
      await utils.garden.feed.cancel(feedQueryInput);
      const previous = utils.garden.feed.getInfiniteData(feedQueryInput);

      utils.garden.feed.setInfiniteData(feedQueryInput, (old) =>
        patchFeedItem(old, postId, (feedItem) => ({
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
        patchFeedItem(old, postId, (feedItem) => ({
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
        style={styles.action}
        onPress={handleToggleLike}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={item.likedByMe ? "Unlike this post" : "Like this post"}
        accessibilityState={{ selected: item.likedByMe }}
      >
        <Ionicons
          name={item.likedByMe ? "heart" : "heart-outline"}
          size={30}
          color={item.likedByMe ? colors.pop : colors.onPrimary}
          style={styles.icon}
        />
        <Text style={styles.count}>{formatCount(item.likeCount)}</Text>
      </Pressable>

      <Pressable
        style={styles.action}
        onPress={() => onOpenComments(item.id, item.storeName)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`View comments (${item.commentCount})`}
      >
        <Ionicons name="chatbubble-outline" size={28} color={colors.onPrimary} style={styles.icon} />
        <Text style={styles.count}>{formatCount(item.commentCount)}</Text>
      </Pressable>

      <Pressable
        style={styles.action}
        onPress={handleShare}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Share this post"
      >
        <Ionicons name="arrow-redo-outline" size={28} color={colors.onPrimary} style={styles.icon} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: "absolute",
    right: spacing.lg,
    bottom: spacing.xxl,
    alignItems: "center",
    gap: spacing.lg,
  },
  // Each action's touch target is >=44pt (icon ~30 + vertical label + hitSlop
  // 10 on every edge comfortably clears the floor).
  action: {
    alignItems: "center",
    minWidth: 44,
    minHeight: 44,
    justifyContent: "center",
    gap: 2,
  },
  // Drop shadow (not a translucent scrim box — the rail floats directly over
  // media with no backing panel) so icons/counts stay readable over bright
  // photos, matching GardenPostOverlay's "always-legible" white-on-media rule.
  icon: {
    textShadowColor: "rgba(0,0,0,0.45)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  count: {
    color: colors.onPrimary,
    fontSize: type.caption.fontSize - 1,
    fontWeight: "700",
    textShadowColor: "rgba(0,0,0,0.45)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
