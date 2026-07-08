/**
 * GardenFeedScreen — vertical, full-cell paged garden stories/reels feed
 * (F-047). Took Search's tab slot; SearchScreen remains reachable as a
 * pushed stack screen (Home's seasonal chips still deep-link to it).
 *
 * Data: trpc.garden.feed.useInfiniteQuery({lat,lng,radiusKm:25,limit:10}),
 * cursor-paginated via nextCursor (server keyset-paginates on
 * created_at DESC, id DESC — see apps/server/src/routers/garden.ts). Only
 * `status: "ready"` posts are ever returned by the server.
 *
 * Layout: a vertical FlatList with pagingEnabled + fixed-height cells (one
 * cell per screen), onEndReached driving the next page, pull-to-refresh via
 * RefreshControl. Each cell renders a GardenPhotoCarousel (photo_set) or a
 * GardenVideoCell (video) depending on the discriminated `type` field.
 *
 * Video player lifecycle (Android decoder ceiling): only the >=60%-visible
 * cell (tracked via onViewableItemsChanged) is "active" (plays); only cells
 * within one index of it are "near" (have a live player at all) — see
 * GardenVideoCell's doc comment for the mechanism.
 *
 * Composer: a floating "+" button is shown only when the signed-in user has
 * a store (trpc.stores.getMine.useQuery(), same procedure YourStandScreen
 * uses to gate seller-only UI). Tapping it pushes GardenComposerScreen.
 *
 * States: location loading/denied/error (mirrors HomeScreen/SearchScreen),
 * feed loading/error+retry/empty, matching the app's existing state styles.
 *
 * React Native only — no DOM elements.
 */

import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type ViewToken,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { GardenFeedItem } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useInfiniteScrollEnd } from "../hooks/useInfiniteScrollEnd";
import { useDeviceLocation } from "../location/useDeviceLocation";
import type { GardensTabNavigationProp, TabParamList } from "../navigation/types";
import { GardenPhotoCarousel } from "../components/GardenPhotoCarousel";
import { GardenVideoCell } from "../components/GardenVideoCell";
import { colors, radii, spacing, type } from "../theme";

const RADIUS_KM = 25;
const PAGE_LIMIT = 10;
const SCREEN_WIDTH = Dimensions.get("window").width;

type Props = Omit<BottomTabScreenProps<TabParamList, "Gardens">, "navigation"> & {
  navigation: GardensTabNavigationProp;
};

// ---------------------------------------------------------------------------
// GardenFeedList — rendered once location is granted. Owns the paged
// FlatList, the infinite query, and the visible-cell tracking that drives
// video player lifecycle.
// ---------------------------------------------------------------------------

type GardenFeedListProps = {
  lat: number;
  lng: number;
  cellHeight: number;
  onNavigateToStore: (storeId: string, storeName: string) => void;
};

function GardenFeedList({ lat, lng, cellHeight, onNavigateToStore }: GardenFeedListProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const {
    data,
    isLoading,
    isRefetching,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = trpc.garden.feed.useInfiniteQuery(
    { lat, lng, radiusKm: RADIUS_KM, limit: PAGE_LIMIT },
    { getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined },
  );

  const items: GardenFeedItem[] = data?.pages.flatMap((page) => page.items) ?? [];
  const activeIndex = items.findIndex((item) => item.id === activeId);

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const firstVisible = viewableItems.find((v) => v.isViewable);
    if (firstVisible) {
      setActiveId((firstVisible.item as GardenFeedItem).id);
    }
  }).current;

  const handleEndReached = useInfiniteScrollEnd({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  });

  if (isLoading) {
    return (
      <View style={styles.centeredState}>
        <ActivityIndicator size="large" color={colors.onPrimary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centeredState}>
        <Text style={styles.stateText}>Could not load the garden feed: {error.message}</Text>
        <Pressable style={styles.retryButton} onPress={() => void refetch()}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={styles.centeredState}>
        <Text style={styles.stateText}>{"\u{1F331}"} No garden posts nearby yet.</Text>
        <Text style={styles.stateSubText}>
          Check back soon, or be the first to share what's growing.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      pagingEnabled
      showsVerticalScrollIndicator={false}
      snapToInterval={cellHeight}
      decelerationRate="fast"
      getItemLayout={(_, index) => ({ length: cellHeight, offset: cellHeight * index, index })}
      viewabilityConfig={viewabilityConfig}
      onViewableItemsChanged={onViewableItemsChanged}
      onEndReached={handleEndReached}
      onEndReachedThreshold={1.5}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={() => void refetch()}
          tintColor={colors.onPrimary}
        />
      }
      ListFooterComponent={
        isFetchingNextPage ? (
          <View style={[styles.footerLoader, { width: SCREEN_WIDTH }]}>
            <ActivityIndicator size="small" color={colors.onPrimary} />
          </View>
        ) : null
      }
      renderItem={({ item, index }) => {
        const isActive = item.id === activeId;
        const isNear = activeIndex === -1 ? index === 0 : Math.abs(index - activeIndex) <= 1;
        const onPressStore = () => onNavigateToStore(item.storeId, item.storeName);

        return (
          <View style={{ height: cellHeight, width: SCREEN_WIDTH }}>
            {item.type === "photo_set" ? (
              <GardenPhotoCarousel item={item} height={cellHeight} onPressStore={onPressStore} />
            ) : (
              <GardenVideoCell
                item={item}
                height={cellHeight}
                isActive={isActive}
                isNear={isNear}
                onPressStore={onPressStore}
              />
            )}
          </View>
        );
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// GardenFeedScreen
// ---------------------------------------------------------------------------

export function GardenFeedScreen({ navigation }: Props) {
  const location = useDeviceLocation();
  const [containerHeight, setContainerHeight] = useState<number | null>(null);

  const { data: store } = trpc.stores.getMine.useQuery();
  const isSeller = store !== null && store !== undefined;

  return (
    <View
      style={styles.container}
      onLayout={(e) => setContainerHeight(e.nativeEvent.layout.height)}
    >
      {location.status === "loading" ? (
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color={colors.onPrimary} />
          <Text style={styles.stateSubText}>Getting your location…</Text>
        </View>
      ) : null}

      {location.status === "denied" ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Location access denied.</Text>
          <Text style={styles.stateSubText}>
            Enable location permissions in Settings to see nearby garden posts.
          </Text>
        </View>
      ) : null}

      {location.status === "error" ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Could not determine your location.</Text>
          <Text style={styles.stateSubText}>Please check your device settings and try again.</Text>
        </View>
      ) : null}

      {location.status === "granted" && location.coords && containerHeight ? (
        <GardenFeedList
          lat={location.coords.lat}
          lng={location.coords.lng}
          cellHeight={containerHeight}
          onNavigateToStore={(storeId, storeName) =>
            navigation.navigate("StoreProfile", { storeId, storeName })
          }
        />
      ) : null}

      {isSeller ? (
        <Pressable
          style={styles.fab}
          onPress={() => navigation.navigate("GardenComposer")}
          accessibilityRole="button"
          accessibilityLabel="New garden post"
        >
          <Ionicons name="add" size={28} color={colors.onPrimary} />
        </Pressable>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // Full-bleed media stage — intentionally black regardless of the warm
  // palette (photos/video need a neutral backdrop for contrast); only the
  // chrome (text, buttons, FAB) is retoned below.
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxxl,
    gap: spacing.sm,
  },
  stateText: {
    fontSize: type.body.fontSize + 1,
    color: colors.onPrimary,
    textAlign: "center",
    fontWeight: "600",
  },
  stateSubText: {
    fontSize: type.caption.fontSize,
    color: colors.onPrimary,
    opacity: 0.8,
    textAlign: "center",
  },
  retryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.onPrimary,
    marginTop: spacing.sm,
  },
  retryText: {
    color: colors.onPrimary,
    fontSize: type.caption.fontSize + 1,
    fontWeight: "600",
  },
  footerLoader: {
    paddingVertical: spacing.xxl,
    alignItems: "center",
    justifyContent: "center",
  },
  fab: {
    position: "absolute",
    right: spacing.xl,
    bottom: 28,
    width: 56,
    height: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
});
