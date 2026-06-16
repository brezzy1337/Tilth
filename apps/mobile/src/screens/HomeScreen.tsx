/**
 * HomeScreen — marketplace browse.
 *
 * Shows nearby produce listings using device GPS (expo-location).
 * Category filter chips: All + Vegetable / Fruit / Herb / Egg / Honey / Other.
 * Each listing card: name, category, price, unit, distance, storeName.
 *
 * Header: username greeting + Sign Out + Your Stand button.
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
import { useDeviceLocation } from "../location/useDeviceLocation";
import type { AuthedStackParamList } from "../navigation/types";
import { capitalise } from "../utils/text";
import { formatCents } from "../utils/money";

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
// BrowseView — rendered once coords are available
// ---------------------------------------------------------------------------

function BrowseView({ lat, lng }: { lat: number; lng: number }) {
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
            <View style={styles.listingCard}>
              <View style={styles.listingRow}>
                <Text style={styles.listingName}>{item.name}</Text>
                <Text style={styles.listingDistance}>{item.distanceKm.toFixed(1)} km</Text>
              </View>
              <Text style={styles.listingPrice}>
                ${formatCents(item.priceCents)} / {item.unit}
              </Text>
              <Text style={styles.listingMeta}>
                {capitalise(item.category)} · {item.storeName}
              </Text>
            </View>
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
  const location = useDeviceLocation();

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>HomeGrown</Text>
          {user ? <Text style={styles.greeting}>Hi, {user.username}</Text> : null}
        </View>
        <View style={styles.headerActions}>
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
        <BrowseView lat={location.coords.lat} lng={location.coords.lng} />
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
  standButton: {
    backgroundColor: "#2d6a4f",
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  standButtonText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  signOutButton: {
    borderWidth: 1,
    borderColor: "#2d6a4f",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  signOutText: {
    color: "#2d6a4f",
    fontSize: 13,
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
  listingCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 1,
  },
  listingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  listingName: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a1a1a",
    flex: 1,
  },
  listingDistance: {
    fontSize: 13,
    color: "#2d6a4f",
    fontWeight: "500",
    marginLeft: 8,
  },
  listingPrice: {
    fontSize: 15,
    color: "#2d6a4f",
    fontWeight: "700",
    marginBottom: 4,
  },
  listingMeta: {
    fontSize: 12,
    color: "#888",
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
