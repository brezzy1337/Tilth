/**
 * HomeScreen — marketplace browse, Airbnb-style map + draggable sheet (F-013).
 * Stall-first (F-050): both the map and the sheet list *stalls* (growers), not
 * individual produce — produce is browsed and added to cart from the stall's
 * store profile, not from Home.
 *
 * Layout: once location is "granted", a full-screen MapView fills the body
 * (one `StallMarker` per grower, aggregated by storeId — a store's listings
 * share the store's lat/lng, and the pin shows up to 3 produce-category
 * emoji drawn from that store's current listings, F-042) with a draggable
 * `BottomSheet` docked over it. The sheet has three snap points
 * (peek / half / full) and contains the "In season now" chips, the category
 * filter bar, and a list of `StallCard` rows (name, up to 6 produce-category
 * emoji, listing count, distance) — all rendered via `BottomSheetFlatList` so
 * drag-to-resize and list-scroll gestures compose correctly. Tapping a
 * `StallCard` (or a map marker) navigates to that stall's store profile,
 * where produce is actually added to the cart.
 *
 * Both the map markers and the sheet list are derived, by one shared
 * `stallMarkers` useMemo (see MapWithSheet), from a single
 * `trpc.listings.nearby.useQuery` call (one network request; category filter
 * lives in HomeScreen and flows down, so both views update live with the
 * filter — a chip narrows which *stalls* show, and each stall's icon set
 * reflects only its matching produce).
 *
 * Community places (F-048) — farmers markets, co-ops, health-food stores —
 * are a second, independent layer on the same map: a separate
 * `trpc.places.nearby.useQuery` call (own network request; no category
 * filter, so it doesn't need to refetch when the listings filter changes)
 * rendered as `PlaceMarker` badges. Place pins are deliberately distinct
 * from the `StallMarker` grower pills — tapping one opens a `PlaceInfoCard`
 * overlaid above the sheet's peek snap, not a storefront. Tapping the map
 * background (MapView `onPress`) dismisses the card. Attribution
 * ("© OpenStreetMap contributors") is required by ODbL since place data
 * derives from OSM, and floats bottom-left over the map alongside the card.
 *
 * Header: brand + greeting, plus compact Orders / Cart (badged) / Sign-out
 * icons. Search and Sell live in the bottom tab bar (F-041), not here.
 *
 * Sourcing entry point (F-049) — when `trpc.places.mine` is non-null (the
 * signed-in user is a linked community-place buyer), a "🧺 Sourcing for
 * {placeName}" banner renders above the map and pushes the SourcingScreen.
 * Separately, `trpc.stores.getMine` (the same "does this user own a store"
 * query YourStandScreen/GardenFeedScreen already use) gates the
 * PlaceInfoCard's "Offer to supply" CTA — a grower taps a place pin, sees
 * the offer button, and it pushes SourcingComposeScreen in offer mode.
 * These two are independent: a user is virtually never both a place buyer
 * and a grower, but nothing here assumes that.
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
import MapView, { type Region } from "react-native-maps";
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
import { StallCard } from "../components/StallCard";
import { PlaceMarker } from "../components/PlaceMarker";
import { PlaceInfoCard } from "../components/PlaceInfoCard";
import { StallMarker, stallBadgeSignature } from "../components/StallMarker";
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
// changes upstream: user coords -> first stall's coords -> pilot-region
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
  points: { lat: number; lng: number }[] | undefined,
): Region {
  const point: { lat: number; lng: number } =
    userCoords ??
    (points && points.length > 0
      ? { lat: points[0].lat, lng: points[0].lng }
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
// Stall aggregation — single source of truth for both the map markers and the
// sheet's `StallCard` rows (F-050). A store's listings share the store's
// lat/lng, so listings are grouped by storeId into one row per stall: an
// ordered (canonical-enum-order) category set for the icon badge/row, a
// listing count, and the stall's minimum per-listing `distanceKm` (computed
// server-side via ST_Distance — every NearbyListing carries one).
//
// Callers are expected to filter out sold-out listings (`quantity === 0` —
// the same predicate ListingCard uses to render its "Sold out" state) before
// calling `buildStallMarkers`, so a stall whose entire inventory is sold out
// drops off both the map and the sheet, and a partially sold-out stall's
// icon row/count reflect only what's actually available. Kept out of this
// function so the aggregation itself stays a simple, filter-free grouping.
// ---------------------------------------------------------------------------

type StoreMarker = {
  storeId: string;
  storeName: string;
  lat: number;
  lng: number;
  categories: ListingCategory[];
  listingCount: number;
  distanceKm: number;
};

// Canonical category order (matches the shared enum) so a store's emoji set
// renders in a stable order across refetches, independent of listing
// insertion order in the `listings.nearby` response.
const CATEGORY_ORDER = listingCategory.options;

function buildStallMarkers(listings: NearbyListing[]): StoreMarker[] {
  const byStore = new Map<
    string,
    {
      storeName: string;
      lat: number;
      lng: number;
      categories: Set<ListingCategory>;
      listingCount: number;
      distanceKm: number;
    }
  >();
  for (const listing of listings) {
    let entry = byStore.get(listing.storeId);
    if (!entry) {
      entry = {
        storeName: listing.storeName,
        lat: listing.lat,
        lng: listing.lng,
        categories: new Set(),
        listingCount: 0,
        distanceKm: listing.distanceKm,
      };
      byStore.set(listing.storeId, entry);
    }
    entry.categories.add(listing.category);
    entry.listingCount += 1;
    entry.distanceKm = Math.min(entry.distanceKm, listing.distanceKm);
  }
  return Array.from(byStore.entries()).map(([storeId, entry]): StoreMarker => ({
    storeId,
    storeName: entry.storeName,
    lat: entry.lat,
    lng: entry.lng,
    // Sort by the shared enum's canonical order so the set is stable
    // across refetches regardless of listing order in the response.
    categories: CATEGORY_ORDER.filter((cat) => entry.categories.has(cat)),
    listingCount: entry.listingCount,
    distanceKm: entry.distanceKm,
  }));
}

// ---------------------------------------------------------------------------
// MapSection — full-screen MapView (fills the body behind the bottom sheet).
// Shows one `StallMarker` per grower (aggregated by storeId, since a store's
// listings all share the store's lat/lng — the badge shows up to 3 of that
// store's produce-category emoji, F-042) plus one `PlaceMarker` per
// community place (F-048) — a second, visually distinct pin layer
// (rounded-square badges, not pills). Tapping a stall marker navigates to
// that store's profile, unchanged; tapping a place pin selects it (info card
// renders in MapWithSheet, above this component). Tapping the map background
// clears the selection. Takes the already-aggregated `stalls` (see
// `buildStallMarkers`, computed once in MapWithSheet and shared with the
// sheet list) plus the places query's `data` as props.
// ---------------------------------------------------------------------------

type MapSectionProps = {
  lat: number;
  lng: number;
  stalls: StoreMarker[];
  places: CommunityPlace[] | undefined;
  onNavigateToStore: (storeId: string, storeName: string) => void;
  onSelectPlace: (place: CommunityPlace) => void;
  onDismissPlace: () => void;
};

function MapSection({
  lat,
  lng,
  stalls,
  places,
  onNavigateToStore,
  onSelectPlace,
  onDismissPlace,
}: MapSectionProps) {
  const initialRegion = useMemo(
    () => computeInitialRegion({ lat, lng }, stalls),
    [lat, lng, stalls],
  );

  return (
    <MapView style={styles.map} initialRegion={initialRegion} onPress={onDismissPlace}>
      {/* Keyed on storeId + stallBadgeSignature(categories): StallMarker sets
          tracksViewChanges={false}, so the rendered badge (up to 3 visible
          emoji + overflow count) must force a remount to re-rasterize
          exactly when that badge would look different. Using the signature
          rather than the full joined category list means a category change
          beyond the visible slice that leaves the badge's pixels unchanged
          (same overflow count) does NOT force a pointless remount. */}
      {stalls.map((store) => (
        <StallMarker
          key={`${store.storeId}-${stallBadgeSignature(store.categories)}`}
          storeId={store.storeId}
          storeName={store.storeName}
          lat={store.lat}
          lng={store.lng}
          categoryEmojis={store.categories.map((cat) => categoryEmoji(cat))}
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
// StallsSheet — the draggable bottom sheet. Lists `StallCard` rows (F-050:
// stall-first Home — a stall shows its produce as an icon row rather than
// listing each item, and produce is added to cart from the stall's store
// profile, not here). Uses BottomSheetFlatList (not a plain FlatList) so
// drag-to-resize and list-scroll gestures compose: a plain FlatList inside a
// BottomSheet breaks that gesture handoff. SeasonalModule and the category
// filter bar are the list's ListHeaderComponent so they scroll away with the
// list rather than eating fixed sheet height. `stalls` is the same
// `buildStallMarkers` aggregation the map renders (see MapWithSheet) — one
// source of truth, so the sheet and the pins never disagree; `data` (the raw
// query result) is only consulted here for loading/error/empty state.
// ---------------------------------------------------------------------------

// Peek height is shared with mapOverlayStack.bottom so the place info card /
// attribution always sit exactly above the docked sheet — change it here only.
const SHEET_PEEK_SNAP = "14%" as const;
const SHEET_SNAP_POINTS = [SHEET_PEEK_SNAP, "48%", "90%"];

type StallsSheetProps = {
  data: NearbyListing[] | undefined;
  stalls: StoreMarker[];
  isLoading: boolean;
  error: { message: string } | null | undefined;
  onRetry: () => void;
  activeCategory: FilterCategory;
  onSelectCategory: (category: FilterCategory) => void;
  onSelectProduce: (produceName: string) => void;
  onPressSearch: () => void;
  onNavigateToStore: (storeId: string, storeName: string) => void;
};

function StallsSheet({
  data,
  stalls,
  isLoading,
  error,
  onRetry,
  activeCategory,
  onSelectCategory,
  onSelectProduce,
  onPressSearch,
  onNavigateToStore,
}: StallsSheetProps) {
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
            <Text style={styles.stateText}>Could not load stalls: {error.message}</Text>
            <Pressable style={styles.retryButton} onPress={onRetry}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Empty-state check drives off the derived `stalls` (post sold-out
            filter), not raw `data` — an area where everything is sold out
            must show the empty message, not a silent blank list. `data &&`
            still gates on the query having resolved at least once. */}
        {!isLoading && !error && data && stalls.length === 0 ? (
          <View style={styles.sheetCenteredState}>
            <Text style={styles.emptyEmoji}>{"\u{1F9FA}"}</Text>
            <Text style={styles.stateText}>No stalls nearby.</Text>
            <Text style={styles.stateSubText}>Check back soon or try a wider search.</Text>
          </View>
        ) : null}
      </View>
    ),
    [activeCategory, data, stalls, error, isLoading, onRetry, onSelectCategory, onSelectProduce, onPressSearch],
  );

  return (
    <BottomSheet
      index={1}
      snapPoints={SHEET_SNAP_POINTS}
      handleIndicatorStyle={styles.sheetHandleIndicator}
      backgroundStyle={styles.sheetBackground}
    >
      <BottomSheetFlatList
        data={stalls}
        keyExtractor={(item) => item.storeId}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          <StallCard
            item={item}
            onPress={() => onNavigateToStore(item.storeId, item.storeName)}
          />
        )}
      />
    </BottomSheet>
  );
}

// ---------------------------------------------------------------------------
// MapWithSheet — the granted-location body. Owns `activeCategory`, the single
// shared `trpc.listings.nearby.useQuery` call, and the `stallMarkers`
// aggregation (`buildStallMarkers`, F-050) derived from it — the full-screen
// map markers and the sheet's stall list both render off this one aggregated
// array, so they stay in sync when the category filter changes and never
// duplicate the grouping logic.
// ---------------------------------------------------------------------------

type MapWithSheetProps = {
  lat: number;
  lng: number;
  onNavigateToStore: (storeId: string, storeName: string) => void;
  onSelectProduce: (produceName: string) => void;
  onPressSearch: () => void;
  canOfferToSupply: boolean;
  onOfferToSupply: (place: CommunityPlace) => void;
};

function MapWithSheet({
  lat,
  lng,
  onNavigateToStore,
  onSelectProduce,
  onPressSearch,
  canOfferToSupply,
  onOfferToSupply,
}: MapWithSheetProps) {
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

  // Sold-out produce (quantity === 0 — same predicate ListingCard uses for
  // its "Sold out" state) is excluded before aggregation so a fully sold-out
  // stall drops off the map/sheet entirely, and a partially sold-out stall's
  // icon row/count reflect only what's actually available.
  const available = useMemo(() => (data ?? []).filter((listing) => listing.quantity > 0), [data]);

  // Single source of truth for both the map pins and the sheet's StallCard
  // rows — see buildStallMarkers. Recomputed only when the filtered listings
  // change (i.e. on a real refetch, not on every render).
  const stallMarkers = useMemo(() => buildStallMarkers(available), [available]);

  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const handleDismissPlace = useCallback(() => setSelectedPlace(undefined), []);

  return (
    <View style={styles.mapWithSheetContainer}>
      <MapSection
        lat={lat}
        lng={lng}
        stalls={stallMarkers}
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
          <PlaceInfoCard
            place={selectedPlace}
            onClose={handleDismissPlace}
            canOfferToSupply={canOfferToSupply}
            onOfferToSupply={() => onOfferToSupply(selectedPlace)}
          />
        ) : null}
        <Text style={styles.attribution}>© OpenStreetMap contributors</Text>
      </View>

      <StallsSheet
        data={data}
        stalls={stallMarkers}
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

  // F-049 sourcing gates — independent of each other (see file-level doc
  // comment). `stores.getMine`/`places.mine` are the same "does this user
  // own a store" / "is this user a linked place buyer" queries other
  // screens already use (YourStandScreen, GardenFeedScreen).
  const { data: myStore } = trpc.stores.getMine.useQuery();
  const { data: myPlace } = trpc.places.mine.useQuery();

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

      {/* Sourcing entry point (F-049) — only for linked community-place buyers */}
      {myPlace ? (
        <Pressable
          style={styles.sourcingBanner}
          onPress={() => navigation.navigate("Sourcing")}
          accessibilityRole="button"
          accessibilityLabel={`Sourcing for ${myPlace.name}`}
        >
          <Text style={styles.sourcingBannerText}>{"\u{1F9FA}"} Sourcing for {myPlace.name}</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.primary} />
        </Pressable>
      ) : null}

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
          canOfferToSupply={myStore !== null && myStore !== undefined}
          onOfferToSupply={(place) =>
            navigation.navigate("SourcingCompose", {
              mode: "offer",
              placeId: place.id,
              placeName: place.name,
            })
          }
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
  sourcingBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radii.md,
  },
  sourcingBannerText: {
    fontSize: type.body.fontSize,
    fontWeight: "700",
    color: colors.primary,
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
  emptyEmoji: {
    fontSize: 40,
    marginBottom: spacing.xs,
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
