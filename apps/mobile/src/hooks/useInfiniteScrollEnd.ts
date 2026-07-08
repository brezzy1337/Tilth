/**
 * useInfiniteScrollEnd — the shared FlatList `onEndReached` callback for
 * tRPC/React Query infinite queries: fetch the next keyset page only when one
 * exists and a fetch isn't already in flight. Extracted from the identical
 * copies in MessagesScreen, ConversationScreen, and GardenFeedScreen.
 */

import { useCallback } from "react";

type InfiniteQueryPager = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
};

export function useInfiniteScrollEnd({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: InfiniteQueryPager): () => void {
  return useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
}
