/**
 * HomeScreen — marketplace browse.
 *
 * Shows nearby produce listings using device GPS (expo-location).
 * Category filter chips: All + Vegetable / Fruit / Herb / Egg / Honey / Other.
 * Each listing card: name, category, price, unit, distance, storeName.
 *
 * Header: username greeting + Search + Sign Out + Your Stand button.
 *
 * States covered: loading (location or query), granted, denied, error, empty.
 *
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { listingCategory, type ListingCategory } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { useCart } from "../cart/CartContext";
import { useDeviceLocation } from "../location/useDeviceLocation";
import type { AuthedStackParamList } from "../navigation/types";
import { capitalise } from "../utils/text";
import { ListingCard } from "../components/ListingCard";
import { getSeasonalProduce } from "../data/seasonalProduce";

type Props = NativeStackScreenProps<AuthedStackParamList, "Home">;

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
          {/* Search entry point */}
          <Pressable
            style={styles.searchButton}
            onPress={() => navigation.navigate("Search")}
          >
            <Text style={styles.searchButtonText}>Search</Text>
          </Pressable>
          {/* Cart button with item-count badge */}
          <Pressable
            style={styles.cartButton}
            onPress={() => navigation.navigate("Cart")}
          >
            <Text style={styles.cartButtonText}>
              Cart{itemCount > 0 ? ` (${itemCount})` : ""}
            </Text>
          </Pressable>
          {/* Orders button */}
          <Pressable
            style={styles.ordersButton}
            onPress={() => navigation.navigate("Orders")}
          >
            <Text style={styles.ordersButtonText}>Orders</Text>
          </Pressable>
          <Pressable style={styles.standButton} onPress={() => navigation.navigate("YourStand")}>
            <Text style={styles.standButtonText}>Your Stand</Text>
          </Pressable>
          <Pressable style={styles.signOutButton} onPress={() => void signOut()}>
            <Text style={styles.signOutText}>Sign Out</Text>
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
  cartButton: {
    backgroundColor: "#2d6a4f",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  cartButtonText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  ordersButton: {
    borderWidth: 1,
    borderColor: "#2d6a4f",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  ordersButtonText: {
    color: "#2d6a4f",
    fontSize: 13,
    fontWeight: "600",
  },
  standButton: {
    borderWidth: 1,
    borderColor: "#2d6a4f",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  standButtonText: {
    color: "#2d6a4f",
    fontSize: 13,
    fontWeight: "600",
  },
  signOutButton: {
    borderWidth: 1,
    borderColor: "#ccc",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  signOutText: {
    color: "#888",
    fontSize: 13,
    fontWeight: "600",
  },
  searchButton: {
    borderWidth: 1,
    borderColor: "#2d6a4f",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  searchButtonText: {
    color: "#2d6a4f",
    fontSize: 13,
    fontWeight: "600",
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
