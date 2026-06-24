/**
 * SearchScreen — full-text + category search over nearby listings.
 *
 * Features:
 *   - Text search box debounced ~300 ms before driving the query.
 *   - Category chip row: All + one chip per listingCategory value.
 *   - Both filters combine (AND): text query + category pass together.
 *   - Results rendered as ListingCard rows (shared with HomeScreen).
 *   - Fixed radiusKm: 50 km (wider than the Home browse feed at 25 km).
 *   - Location states mirrored from HomeScreen: loading, denied, error, granted.
 *   - Query states: loading spinner, empty state, error + retry.
 *
 * React Native only — no DOM elements.
 */

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { listingCategory, type ListingCategory } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useDeviceLocation } from "../location/useDeviceLocation";
import type { AuthedStackParamList } from "../navigation/types";
import { capitalise } from "../utils/text";
import { ListingCard } from "../components/ListingCard";

type Props = NativeStackScreenProps<AuthedStackParamList, "Search">;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RADIUS_KM = 50;
const DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Category filter options
// ---------------------------------------------------------------------------

type FilterCategory = ListingCategory | "all";

const FILTER_OPTIONS: { label: string; value: FilterCategory }[] = [
  { label: "All", value: "all" },
  ...listingCategory.options.map((cat) => ({
    label: capitalise(cat),
    value: cat as FilterCategory,
  })),
];

// ---------------------------------------------------------------------------
// SearchView — rendered once coords are available
// ---------------------------------------------------------------------------

type SearchViewProps = {
  lat: number;
  lng: number;
  onNavigateToStore: (storeId: string, storeName: string) => void;
};

function SearchView({ lat, lng, onNavigateToStore }: SearchViewProps) {
  const [inputText, setInputText] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState<string | undefined>(undefined);
  const [activeCategory, setActiveCategory] = useState<FilterCategory>("all");

  // Debounce the text input: copy to debouncedQuery after DEBOUNCE_MS of silence.
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = inputText.trim();
      setDebouncedQuery(trimmed.length > 0 ? trimmed : undefined);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inputText]);

  const category: ListingCategory | undefined =
    activeCategory === "all" ? undefined : activeCategory;

  const { data, isLoading, error, refetch } = trpc.listings.nearby.useQuery(
    {
      lat,
      lng,
      radiusKm: RADIUS_KM,
      query: debouncedQuery,
      category,
    },
    { enabled: true },
  );

  return (
    <View style={styles.container}>
      {/* Search box */}
      <View style={styles.searchBoxWrapper}>
        <TextInput
          style={styles.searchBox}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Search produce…"
          placeholderTextColor="#aaa"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>

      {/* Category chips */}
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

      {/* Loading */}
      {isLoading ? (
        <ActivityIndicator size="large" color="#2d6a4f" style={styles.centeredLoader} />
      ) : null}

      {/* Error */}
      {error ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Could not load results: {error.message}</Text>
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Empty state */}
      {!isLoading && !error && data && data.length === 0 ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>No produce found.</Text>
          <Text style={styles.stateSubText}>
            Try adjusting your search term or selecting a different category.
          </Text>
          {inputText.length > 0 || activeCategory !== "all" ? (
            <Pressable
              style={styles.clearFiltersButton}
              onPress={() => {
                setInputText("");
                setDebouncedQuery(undefined);
                setActiveCategory("all");
              }}
            >
              <Text style={styles.clearFiltersText}>Clear filters</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Results */}
      {data && data.length > 0 ? (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
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
// SearchScreen
// ---------------------------------------------------------------------------

export function SearchScreen({ navigation }: Props) {
  const location = useDeviceLocation();

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Location: loading */}
      {location.status === "loading" ? (
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color="#2d6a4f" />
          <Text style={styles.stateSubText}>Getting your location…</Text>
        </View>
      ) : null}

      {/* Location: denied */}
      {location.status === "denied" ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Location access denied.</Text>
          <Text style={styles.stateSubText}>
            Enable location permissions in Settings to search nearby produce.
          </Text>
        </View>
      ) : null}

      {/* Location: error */}
      {location.status === "error" ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Could not determine your location.</Text>
          <Text style={styles.stateSubText}>
            Please check your device settings and try again.
          </Text>
        </View>
      ) : null}

      {/* Location ready — render search UI */}
      {location.status === "granted" && location.coords ? (
        <SearchView
          lat={location.coords.lat}
          lng={location.coords.lng}
          onNavigateToStore={(storeId, storeName) =>
            navigation.navigate("StoreProfile", { storeId, storeName })
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
    backgroundColor: "#f7f9f7",
  },
  container: {
    flex: 1,
  },
  searchBoxWrapper: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  searchBox: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: "#1a1a1a",
  },
  filterBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
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
  clearFiltersButton: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: "#2d6a4f",
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
  },
  clearFiltersText: {
    fontSize: 14,
    color: "#2d6a4f",
    fontWeight: "600",
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
