/**
 * Shared `garden.feed` infinite-query cache helpers (F-053).
 *
 * `GardenActionRail` (like toggling) and `GardenCommentsSheet` (comment-count
 * patches) both need to patch the SAME cached `garden.feed` page data that
 * `GardenFeedScreen` reads from — react-query keys an infinite query by its
 * input, structurally, so `buildGardenFeedQueryInput` is the ONE place that
 * input shape gets built. `GardenFeedScreen`'s own `useInfiniteQuery` call
 * (for the list itself) and its comments-sheet `feedQueryInput` must be built
 * through this same function — a hand-built literal that silently drifts
 * (a renamed field, a different key order doesn't matter, but a different
 * *value*, e.g. a stale radius) would produce a different cache key, and
 * every optimistic patch below would silently no-op against the wrong entry.
 */

import type { GardenFeedInput, GardenFeedItem, GardenFeedOutput } from "@homegrown/shared";

export const GARDEN_FEED_RADIUS_KM = 25;
export const GARDEN_FEED_PAGE_LIMIT = 10;

export function buildGardenFeedQueryInput(lat: number, lng: number): GardenFeedInput {
  return { lat, lng, radiusKm: GARDEN_FEED_RADIUS_KM, limit: GARDEN_FEED_PAGE_LIMIT };
}

// `pageParams` is typed to match `garden.feed`'s cursor exactly (its
// `nextCursor` field, which doubles as the next page's param, is
// `string | null`) — react-query's InfiniteData<T, TPageParam> otherwise
// rejects a widened `unknown[]` when handed back via setInfiniteData.
export type GardenFeedInfiniteData = { pages: GardenFeedOutput[]; pageParams: (string | null)[] };

/** Patch a single feed item across every cached page, leaving everything else untouched. */
export function patchGardenFeedItem(
  data: GardenFeedInfiniteData | undefined,
  postId: string,
  patch: (item: GardenFeedItem) => GardenFeedItem,
): GardenFeedInfiniteData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.id === postId ? patch(item) : item)),
    })),
  };
}
