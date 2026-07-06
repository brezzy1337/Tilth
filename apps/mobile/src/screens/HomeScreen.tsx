/**
 * HomeScreen — marketplace browse.
 *
 * Shows nearby produce listings using device GPS (expo-location).
 * Category filter chips: All + Vegetable / Fruit / Herb / Egg / Honey / Other.
 * Each listing card: name, category, price, unit, distance, storeName.
 *
 * Header: brand + greeting, plus compact Orders / Cart (badged) / Sign-out
 * icons. Search and Sell live in the bottom tab bar (F-041), not here.
 *
 * States covered: loading (location or query), granted, denied, error, empty.
 *
 * React Native only — no DOM elements.
 */

import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import MapView, { Marker, type Region } from "react-native-maps";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import { listingCategory, type ListingCategory, type NearbyListing } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { useCart } from "../cart/CartContext";
import { useDeviceLocation } from "../location/useDeviceLocation";
import type { HomeTabNavigationProp, TabParamList } from "../navigation/types";
import { capitalise } from "../utils/text";
import { ListingCard } from "../components/ListingCard";
import { getSeasonalProduce } from "../data/seasonalProduce";

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
  { label: "All", value: "all" },
  ...listingCategory.options.map((cat) => ({ label: capitalise(cat), value: cat as FilterCategory })),
];

// ---------------------------------------------------------------------------
// SeasonalModule — "In season now" tappable produce shortcuts
// ---------------------------------------------------------------------------

type SeasonalModuleProps = {
  onSelectProduce: (produceName: string) => void;
};

function SeasonalModule({ onSelectProduce }: SeasonalModuleProps) {
  const { monthLabel, produce } = getSeasonalProduce();

  if (produce.length === 0) {
    return null;
  }

  return (
    <View style={styles.seasonalSection}>
      <Text style={styles.seasonalHeading}>In season now · {monthLabel}</Text>
      <FlatList
        data={produce}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item}
        contentContainerStyle={styles.seasonalChipRow}
        renderItem={({ item }) => (
          <Pressable style={styles.seasonalChip} onPress={() => onSelectProduce(item)}>
            <Text style={styles.seasonalChipText}>{item}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// MapSection — F-013 native map foundation. Prominent, fixed-height MapView
// showing one Marker per grower (deduped by storeId, since a store's listings
// all share the store's lat/lng). Tapping a Marker navigates to that store's
// profile. This is the pre-rebuild phase: a plain map alongside the existing
// list, NOT the full-screen-map + bottom-sheet layout (that's next, once
// these native modules are compiled into a dev-client).
//
// Reuses the same { lat, lng, radiusKm: 25, category: undefined } query key
// BrowseView issues by default (activeCategory "all" -> category undefined),
// so TanStack Query dedupes the network request between the two sections.
// ---------------------------------------------------------------------------

type MapSectionProps = {
  lat: number;
  lng: number;
  onNavigateToStore: (storeId: string, storeName: string) => void;
};

function MapSection({ lat, lng, onNavigateToStore }: MapSectionProps) {
  const { data } = trpc.listings.nearby.useQuery({ lat, lng, radiusKm: 25 });

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
    <View style={styles.mapSection}>
      <MapView style={styles.map} initialRegion={initialRegion}>
        {storeMarkers.map((store) => (
          <Marker
            key={store.storeId}
            coordinate={{ latitude: store.lat, longitude: store.lng }}
            title={store.storeName}
            onPress={() => onNavigateToStore(store.storeId, store.storeName)}
          />
        ))}
      </MapView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// BrowseView — rendered once coords are available
// ---------------------------------------------------------------------------

type BrowseViewProps = {
  lat: number;
  lng: number;
  onNavigateToStore: (storeId: string, storeName: string) => void;
};

function BrowseView({ lat, lng, onNavigateToStore }: BrowseViewProps) {
  const [activeCategory, setActiveCategory] = useState<FilterCategory>("all");

  const category: ListingCategory | undefined =
    activeCategory === "all" ? undefined : activeCategory;

  const { data, isLoading, error, refetch } = trpc.listings.nearby.useQuery(
    { lat, lng, radiusKm: 25, category },
    { enabled: true },
  );

  return (
    <View style={styles.browseContainer}>
      {/* Category filter chips */}
      <FlatList
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
            onPress={() => setActiveCategory(item.value)}
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

      {/* Listings */}
      {isLoading && (
        <ActivityIndicator size="large" color="#2d6a4f" style={styles.centeredLoader} />
      )}

      {error ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Could not load listings: {error.message}</Text>
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {!isLoading && !error && data && data.length === 0 ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>No produce nearby.</Text>
          <Text style={styles.stateSubText}>Check back soon or try a wider search.</Text>
        </View>
      ) : null}

      {data && data.length > 0 ? (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          scrollEnabled={false}
          renderItem={({ item }) => (
            <ListingCard
              item={item}
              onPressStore={() => onNavigateToStore(item.storeId, item.storeName)}
            />
          )}
        />
      ) : null}
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
            <Ionicons name="receipt-outline" size={22} color="#2d6a4f" />
          </Pressable>
          {/* Cart with item-count badge */}
          <Pressable
            style={styles.iconButton}
            onPress={() => navigation.navigate("Cart")}
            accessibilityRole="button"
            accessibilityLabel={`Cart${itemCount > 0 ? `, ${itemCount} items` : ""}`}
          >
            <Ionicons name="cart-outline" size={24} color="#2d6a4f" />
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
            <Ionicons name="log-out-outline" size={22} color="#888" />
          </Pressable>
        </View>
      </View>

      {/* Body — state-driven */}
      {location.status === "loading" ? (
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color="#2d6a4f" />
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
        <>
          <MapSection
            lat={location.coords.lat}
            lng={location.coords.lng}
            onNavigateToStore={(storeId, storeName) =>
              navigation.navigate("StoreProfile", { storeId, storeName })
            }
          />
          <SeasonalModule
            onSelectProduce={(produceName) =>
              navigation.navigate("Search", { initialQuery: produceName })
            }
          />
          <BrowseView
            lat={location.coords.lat}
            lng={location.coords.lng}
            onNavigateToStore={(storeId, storeName) =>
              navigation.navigate("StoreProfile", { storeId, storeName })
            }
          />
        </>
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
    backgroundColor: "#f7f9f7",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#e8eae8",
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#2d6a4f",
  },
  greeting: {
    fontSize: 13,
    color: "#666",
    marginTop: 2,
  },
  headerActions: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  iconButton: {
    padding: 6,
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
    backgroundColor: "#e63946",
    alignItems: "center",
    justifyContent: "center",
  },
  cartBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },
  seasonalSection: {
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#e8eae8",
    paddingTop: 12,
    paddingBottom: 4,
  },
  seasonalHeading: {
    fontSize: 15,
    fontWeight: "700",
    color: "#2d6a4f",
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  seasonalChipRow: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  seasonalChip: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#2d6a4f",
    backgroundColor: "#eaf3ee",
  },
  seasonalChipText: {
    fontSize: 13,
    color: "#2d6a4f",
    fontWeight: "600",
  },
  mapSection: {
    height: 300,
    borderBottomWidth: 1,
    borderBottomColor: "#e8eae8",
  },
  map: StyleSheet.absoluteFill,
  browseContainer: {
    flex: 1,
  },
  filterBar: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  filterChip: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  filterChipActive: {
    backgroundColor: "#2d6a4f",
    borderColor: "#2d6a4f",
  },
  filterChipText: {
    fontSize: 13,
    color: "#555",
  },
  filterChipTextActive: {
    color: "#fff",
    fontWeight: "600",
  },
  centeredLoader: {
    marginTop: 60,
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 8,
  },
  stateText: {
    fontSize: 16,
    color: "#444",
    textAlign: "center",
    fontWeight: "600",
  },
  stateSubText: {
    fontSize: 13,
    color: "#888",
    textAlign: "center",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  retryButton: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2d6a4f",
    marginTop: 8,
  },
  retryText: {
    color: "#2d6a4f",
    fontSize: 14,
    fontWeight: "600",
  },
});
