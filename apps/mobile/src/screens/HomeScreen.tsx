/**
 * HomeScreen — marketplace browse, Airbnb-style map + draggable sheet (F-013).
 *
 * Layout: once location is "granted", a full-screen MapView fills the body
 * (one Marker per grower, deduped by storeId — a store's listings share the
 * store's lat/lng) with a draggable `BottomSheet` docked over it. The sheet
 * has three snap points (peek / half / full) and contains the "In season
 * now" chips, the category filter bar, and the listings list — all rendered
 * via `BottomSheetFlatList` so drag-to-resize and list-scroll gestures
 * compose correctly.
 *
 * Both the map markers and the sheet list read from a single, shared
 * `trpc.listings.nearby.useQuery` call (one network request; category filter
 * lives in HomeScreen and flows down, so pins update live with the filter).
 *
 * Community places (F-048) — farmers markets, co-ops, health-food stores —
 * are a second, independent layer on the same map: a separate
 * `trpc.places.nearby.useQuery` call (own network request; no category
 * filter, so it doesn't need to refetch when the listings filter changes)
 * rendered as `PlaceMarker` badges. Place pins are deliberately NOT the
 * default teardrop grower pins — tapping one opens a `PlaceInfoCard`
 * overlaid above the sheet's peek snap, not a storefront. Tapping the map
 * background (MapView `onPress`) dismisses the card. Attribution
 * ("© OpenStreetMap contributors") is required by ODbL since place data
 * derives from OSM, and floats bottom-left over the map alongside the card.
 *
 * Header: brand + greeting, plus compact Orders / Cart (badged) / Sign-out
 * icons. Search and Sell live in the bottom tab bar (F-041), not here.
 *
 * States covered: loading (location or query), granted, denied, error, empty.
 * The denied/error/loading location states render in place of the map+sheet,
 * unchanged from before.
 *
 * React Native only — no DOM elements.
 */

import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import MapView, { Marker, type Region } from "react-native-maps";
import BottomSheet, { BottomSheetFlatList } from "@gorhom/bottom-sheet";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import {
  listingCategory,
  type CommunityPlace,
  type ListingCategory,
  type NearbyListing,
} from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { useCart } from "../cart/CartContext";
import { useDeviceLocation } from "../location/useDeviceLocation";
import type { HomeTabNavigationProp, TabParamList } from "../navigation/types";
import { capitalise } from "../utils/text";
import { ListingCard } from "../components/ListingCard";
import { PlaceMarker } from "../components/PlaceMarker";
import { PlaceInfoCard } from "../components/PlaceInfoCard";
import { getSeasonalProduce } from "../data/seasonalProduce";
import { colors, radii, spacing, type } from "../theme";
import { CATEGORY_EMOJI, categoryEmoji, produceEmoji } from "../theme/categoryEmoji";
// Horizontal rows nested inside the bottom sheet must use gesture-handler's
// FlatList — the sheet's pan gesture swallows horizontal drags from RN-core
// lists (chips render but won't slide).
import { FlatList as GestureFlatList } from "react-native-gesture-handler";

// ---------------------------------------------------------------------------
// Map region fallback — used only when the device coords aren't usable for a
// region (defensive; HomeScreen only mounts the map once location is
// "granted", but MapSection keeps its own fallback chain in case that ever
// changes upstream: user coords -> first listing's coords -> pilot-region
// default, so the map never crashes on missing input).
// ---------------------------------------------------------------------------

const FALLBACK_REGION = {
  // San Francisco — matches the server's nearby-query integration test fixtures.
  latitude: 37.7749,
  longitude: -122.4194,
};

const REGION_DELTA = {
  latitudeDelta: 0.15,
  longitudeDelta: 0.15,
};

function computeInitialRegion(
  userCoords: { lat: number; lng: number } | undefined,
  listings: NearbyListing[] | undefined,
): Region {
  const point: { lat: number; lng: number } =
    userCoords ??
    (listings && listings.length > 0
      ? { lat: listings[0].lat, lng: listings[0].lng }
      : { lat: FALLBACK_REGION.latitude, lng: FALLBACK_REGION.longitude });

  return {
    latitude: point.lat,
    longitude: point.lng,
    ...REGION_DELTA,
  };
}

type Props = Omit<BottomTabScreenProps<TabParamList, "Home">, "navigation"> & {
  navigation: HomeTabNavigationProp;
};

// ---------------------------------------------------------------------------
// Category filter bar
// ---------------------------------------------------------------------------

type FilterCategory = ListingCategory | "all";

const FILTER_OPTIONS: { label: string; value: FilterCategory }[] = [
  { label: `${CATEGORY_EMOJI.other} All`, value: "all" },
  ...listingCategory.options.map((cat) => ({
    label: `${categoryEmoji(cat)} ${capitalise(cat)}`,
    value: cat as FilterCategory,
  })),
];

// ---------------------------------------------------------------------------
// SeasonalModule — "In season now" tappable produce shortcuts
// ---------------------------------------------------------------------------

type SeasonalModuleProps = {
  onSelectProduce: (produceName: string) => void;
  onPressSearch: () => void;
};

function SeasonalModule({ onSelectProduce, onPressSearch }: SeasonalModuleProps) {
  const { monthLabel, produce } = getSeasonalProduce();

  if (produce.length === 0) {
    return null;
  }

  return (
    <View style={styles.seasonalSection}>
      {/* Search sits in the heading row (not the slider) so it stays visible
          at any chip-scroll position instead of scrolling off with the row. */}
      <View style={styles.seasonalHeadingRow}>
        <Text style={styles.seasonalHeading}>In season now · {monthLabel}</Text>
        <Pressable
          style={styles.seasonalSearchButton}
          onPress={onPressSearch}
          accessibilityRole="button"
          accessibilityLabel="Search produce"
        >
          <Ionicons name="search" size={16} color={colors.primary} />
        </Pressable>
      </View>
      <GestureFlatList
        data={produce}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item}
        contentContainerStyle={styles.seasonalChipRow}
        renderItem={({ item }) => (
          <Pressable style={styles.seasonalChip} onPress={() => onSelectProduce(item)}>
            <Text style={styles.seasonalChipText}>{`${produceEmoji(item)} ${item}`}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// MapSection — full-screen MapView (fills the body behind the bottom sheet).
// Shows one Marker per grower (deduped by storeId, since a store's listings
// all share the store's lat/lng) plus one `PlaceMarker` per community place
// (F-048) — a second, visually distinct pin layer (rounded-square badges,
// not teardrops). Tapping a grower Marker navigates to that store's profile,
// unchanged; tapping a place pin selects it (info card renders in
// MapWithSheet, above this component). Tapping the map background clears
// the selection. Takes both queries' `data` as props — HomeScreen owns the
// `trpc.listings.nearby` and `trpc.places.nearby` calls so the map and the
// sheet list stay in sync off the same network requests.
// ---------------------------------------------------------------------------

type MapSectionProps = {
  lat: number;
  lng: number;
  data: NearbyListing[] | undefined;
  places: CommunityPlace[] | undefined;
  onNavigateToStore: (storeId: string, storeName: string) => void;
  onSelectPlace: (place: CommunityPlace) => void;
  onDismissPlace: () => void;
};

function MapSection({
  lat,
  lng,
  data,
  places,
  onNavigateToStore,
  onSelectPlace,
  onDismissPlace,
}: MapSectionProps) {
  const storeMarkers = useMemo(() => {
    const byStore = new Map<string, NearbyListing>();
    for (const listing of data ?? []) {
      if (!byStore.has(listing.storeId)) {
        byStore.set(listing.storeId, listing);
      }
    }
    return Array.from(byStore.values());
  }, [data]);

  const initialRegion = useMemo(
    () => computeInitialRegion({ lat, lng }, data),
    [lat, lng, data],
  );

  return (
    <MapView style={styles.map} initialRegion={initialRegion} onPress={onDismissPlace}>
      {storeMarkers.map((store) => (
        <Marker
          key={store.storeId}
          coordinate={{ latitude: store.lat, longitude: store.lng }}
          title={store.storeName}
          onPress={() => onNavigateToStore(store.storeId, store.storeName)}
        />
      ))}
      {/* Keyed on id+type: PlaceMarker sets tracksViewChanges={false}, so a
          type reclassification must force a remount to re-rasterize the badge. */}
      {(places ?? []).map((place) => (
        <PlaceMarker key={`${place.id}-${place.type}`} place={place} onPress={() => onSelectPlace(place)} />
      ))}
    </MapView>
  );
}

// ---------------------------------------------------------------------------
// CategoryFilterBar — extracted so it can be reused as the sheet's list
// header alongside SeasonalModule.
// ---------------------------------------------------------------------------

type CategoryFilterBarProps = {
  activeCategory: FilterCategory;
  onSelectCategory: (category: FilterCategory) => void;
};

function CategoryFilterBar({ activeCategory, onSelectCategory }: CategoryFilterBarProps) {
  return (
    <GestureFlatList
      data={FILTER_OPTIONS}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyExtractor={(item) => item.value}
      contentContainerStyle={styles.filterBar}
      renderItem={({ item }) => (
        <Pressable
          style={[
            styles.filterChip,
            activeCategory === item.value ? styles.filterChipActive : null,
          ]}
          onPress={() => onSelectCategory(item.value)}
        >
          <Text
            style={[
              styles.filterChipText,
              activeCategory === item.value ? styles.filterChipTextActive : null,
            ]}
          >
            {item.label}
          </Text>
        </Pressable>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// ListingsSheet — the draggable bottom sheet. Uses BottomSheetFlatList (not a
// plain FlatList) so drag-to-resize and list-scroll gestures compose: a plain
// FlatList inside a BottomSheet breaks that gesture handoff. SeasonalModule
// and the category filter bar are the list's ListHeaderComponent so they
// scroll away with the list rather than eating fixed sheet height.
// ---------------------------------------------------------------------------

// Peek height is shared with mapOverlayStack.bottom so the place info card /
// attribution always sit exactly above the docked sheet — change it here only.
const SHEET_PEEK_SNAP = "14%" as const;
const SHEET_SNAP_POINTS = [SHEET_PEEK_SNAP, "48%", "90%"];

type ListingsSheetProps = {
  data: NearbyListing[] | undefined;
  isLoading: boolean;
  error: { message: string } | null | undefined;
  onRetry: () => void;
  activeCategory: FilterCategory;
  onSelectCategory: (category: FilterCategory) => void;
  onSelectProduce: (produceName: string) => void;
  onPressSearch: () => void;
  onNavigateToStore: (storeId: string, storeName: string) => void;
};

function ListingsSheet({
  data,
  isLoading,
  error,
  onRetry,
  activeCategory,
  onSelectCategory,
  onSelectProduce,
  onPressSearch,
  onNavigateToStore,
}: ListingsSheetProps) {
  const header = useMemo(
    () => (
      <View>
        <SeasonalModule onSelectProduce={onSelectProduce} onPressSearch={onPressSearch} />
        <CategoryFilterBar activeCategory={activeCategory} onSelectCategory={onSelectCategory} />

        {isLoading && (
          <ActivityIndicator size="large" color={colors.primary} style={styles.centeredLoader} />
        )}

        {error ? (
          <View style={styles.sheetCenteredState}>
            <Text style={styles.stateText}>Could not load listings: {error.message}</Text>
            <Pressable style={styles.retryButton} onPress={onRetry}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {!isLoading && !error && data && data.length === 0 ? (
          <View style={styles.sheetCenteredState}>
            <Text style={styles.stateText}>No produce nearby.</Text>
            <Text style={styles.stateSubText}>Check back soon or try a wider search.</Text>
          </View>
        ) : null}
      </View>
    ),
    [activeCategory, data, error, isLoading, onRetry, onSelectCategory, onSelectProduce, onPressSearch],
  );

  return (
    <BottomSheet
      index={1}
      snapPoints={SHEET_SNAP_POINTS}
      handleIndicatorStyle={styles.sheetHandleIndicator}
      backgroundStyle={styles.sheetBackground}
    >
      <BottomSheetFlatList
        data={data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          <ListingCard
            item={item}
            onPressStore={() => onNavigateToStore(item.storeId, item.storeName)}
          />
        )}
      />
    </BottomSheet>
  );
}

// ---------------------------------------------------------------------------
// MapWithSheet — the granted-location body. Owns `activeCategory` and the
// single shared `trpc.listings.nearby.useQuery` call so the full-screen map
// markers and the sheet's listing list read from the same network request
// and stay in sync when the category filter changes.
// ---------------------------------------------------------------------------

type MapWithSheetProps = {
  lat: number;
  lng: number;
  onNavigateToStore: (storeId: string, storeName: string) => void;
  onSelectProduce: (produceName: string) => void;
  onPressSearch: () => void;
};

function MapWithSheet({ lat, lng, onNavigateToStore, onSelectProduce, onPressSearch }: MapWithSheetProps) {
  const [activeCategory, setActiveCategory] = useState<FilterCategory>("all");
  const [selectedPlace, setSelectedPlace] = useState<CommunityPlace | undefined>(undefined);

  const category: ListingCategory | undefined =
    activeCategory === "all" ? undefined : activeCategory;

  const { data, isLoading, error, refetch } = trpc.listings.nearby.useQuery(
    {
      lat,
      lng,
      radiusKm: 25,
      category,
    },
    // Keep prior results while a category switch refetches — otherwise the
    // map pins all vanish until the new response lands.
    { placeholderData: (prev) => prev },
  );

  // Independent query — places have no category filter, so this never
  // refetches when the listings category changes. Same placeholderData
  // trick as listings so place pins don't blink on remount/refocus.
  const { data: placesData } = trpc.places.nearby.useQuery(
    { lat, lng, radiusKm: 25 },
    { placeholderData: (prev) => prev },
  );

  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const handleDismissPlace = useCallback(() => setSelectedPlace(undefined), []);

  return (
    <View style={styles.mapWithSheetContainer}>
      <MapSection
        lat={lat}
        lng={lng}
        data={data}
        places={placesData}
        onNavigateToStore={onNavigateToStore}
        onSelectPlace={setSelectedPlace}
        onDismissPlace={handleDismissPlace}
      />

      {/* Place-pin chrome (info card + OSM attribution) — floats above the
          sheet's "14%" peek snap so it's visible at the default granted-
          location state. At the "48%"/"90%" snaps the sheet (rendered after
          this in the tree, and internally elevated by @gorhom) simply covers
          it, which is acceptable — dismissing the card on sheet-drag is not
          required. */}
      <View style={styles.mapOverlayStack} pointerEvents="box-none">
        {selectedPlace ? (
          <PlaceInfoCard place={selectedPlace} onClose={handleDismissPlace} />
        ) : null}
        <Text style={styles.attribution}>© OpenStreetMap contributors</Text>
      </View>

      <ListingsSheet
        data={data}
        isLoading={isLoading}
        error={error}
        onRetry={handleRetry}
        activeCategory={activeCategory}
        onSelectCategory={setActiveCategory}
        onSelectProduce={onSelectProduce}
        onPressSearch={onPressSearch}
        onNavigateToStore={onNavigateToStore}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// HomeScreen
// ---------------------------------------------------------------------------

export function HomeScreen({ navigation }: Props) {
  const { user, signOut } = useAuth();
  const { itemCount } = useCart();
  const location = useDeviceLocation();

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Tilth</Text>
          {user ? <Text style={styles.greeting}>Hi, {user.username}</Text> : null}
        </View>
        <View style={styles.headerActions}>
          {/* Orders — Search & Sell moved to the bottom tab bar (F-041) */}
          <Pressable
            style={styles.iconButton}
            onPress={() => navigation.navigate("Orders")}
            accessibilityRole="button"
            accessibilityLabel="Orders"
          >
            <Ionicons name="receipt-outline" size={22} color={colors.primary} />
          </Pressable>
          {/* Cart with item-count badge */}
          <Pressable
            style={styles.iconButton}
            onPress={() => navigation.navigate("Cart")}
            accessibilityRole="button"
            accessibilityLabel={`Cart${itemCount > 0 ? `, ${itemCount} items` : ""}`}
          >
            <Ionicons name="cart-outline" size={24} color={colors.primary} />
            {itemCount > 0 ? (
              <View style={styles.cartBadge}>
                <Text style={styles.cartBadgeText}>
                  {itemCount > 9 ? "9+" : itemCount}
                </Text>
              </View>
            ) : null}
          </Pressable>
          {/* Sign out — subtle account control */}
          <Pressable
            style={styles.iconButton}
            onPress={() => void signOut()}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
          >
            <Ionicons name="log-out-outline" size={22} color={colors.textMuted} />
          </Pressable>
        </View>
      </View>

      {/* Body — state-driven */}
      {location.status === "loading" ? (
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.stateSubText}>Getting your location…</Text>
        </View>
      ) : null}

      {location.status === "denied" ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Location access denied.</Text>
          <Text style={styles.stateSubText}>
            Enable location permissions in Settings to browse nearby produce.
          </Text>
        </View>
      ) : null}

      {location.status === "error" ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Could not determine your location.</Text>
          <Text style={styles.stateSubText}>Please check your device settings and try again.</Text>
        </View>
      ) : null}

      {location.status === "granted" && location.coords ? (
        <MapWithSheet
          lat={location.coords.lat}
          lng={location.coords.lng}
          onNavigateToStore={(storeId, storeName) =>
            navigation.navigate("StoreProfile", { storeId, storeName })
          }
          onSelectProduce={(produceName) =>
            navigation.navigate("Search", { initialQuery: produceName })
          }
          onPressSearch={() => navigation.navigate("Search")}
        />
      ) : null}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize: type.title.fontSize,
    fontWeight: type.title.fontWeight,
    color: colors.primary,
  },
  greeting: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
  },
  iconButton: {
    padding: spacing.sm - 2,
    position: "relative",
  },
  cartBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.pop,
    alignItems: "center",
    justifyContent: "center",
  },
  cartBadgeText: {
    color: colors.onPrimary,
    fontSize: 10,
    fontWeight: "700",
  },
  seasonalSection: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  seasonalHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  seasonalHeading: {
    fontSize: type.body.fontSize,
    fontWeight: "700",
    color: colors.primary,
  },
  seasonalSearchButton: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  seasonalChipRow: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  seasonalChip: {
    paddingVertical: spacing.sm - 2,
    paddingHorizontal: spacing.md + 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  seasonalChipText: {
    fontSize: type.caption.fontSize,
    color: colors.primary,
    fontWeight: "600",
  },
  mapWithSheetContainer: {
    flex: 1,
  },
  map: StyleSheet.absoluteFill,
  // Anchored at the sheet's "14%" peek height (SHEET_SNAP_POINTS[0]) so the
  // info card and attribution sit just above it rather than overlapping —
  // see the comment above this View's usage in MapWithSheet for the
  // 48%/90%-snap tradeoff.
  mapOverlayStack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: SHEET_PEEK_SNAP,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  attribution: {
    alignSelf: "flex-start",
    fontSize: 10,
    color: colors.textMuted,
  },
  sheetBackground: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sheetHandleIndicator: {
    backgroundColor: colors.border,
    width: 40,
  },
  filterBar: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  filterChip: {
    paddingVertical: spacing.sm - 2,
    paddingHorizontal: spacing.md + 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  filterChipText: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
  },
  filterChipTextActive: {
    color: colors.onPrimary,
    fontWeight: "600",
  },
  centeredLoader: {
    marginTop: 60,
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxxl,
    gap: spacing.sm,
  },
  // Same visual treatment as centeredState, but without flex:1 — this one is
  // embedded inside the sheet's ListHeaderComponent (a content-sized View,
  // not a flex-filled screen region), so it needs an explicit vertical
  // padding instead of "grow to fill parent" to stay visible.
  sheetCenteredState: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxxl,
    paddingVertical: 48,
    gap: spacing.sm,
  },
  stateText: {
    fontSize: 16,
    color: colors.text,
    textAlign: "center",
    fontWeight: "600",
  },
  stateSubText: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    textAlign: "center",
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxxl,
  },
  retryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    marginTop: spacing.sm,
  },
  retryText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: "600",
  },
});
