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
import { colors, radii, spacing, type } from "../theme";

// Search is a pushed stack screen (not a tab) — Gardens replaced its tab slot
// (F-047). Home's seasonal chips still deep-link here via
// navigation.navigate("Search", { initialQuery }).
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
  initialQuery?: string;
  onNavigateToStore: (storeId: string, storeName: string) => void;
};

function SearchView({ lat, lng, initialQuery, onNavigateToStore }: SearchViewProps) {
  const [inputText, setInputText] = useState(initialQuery ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState<string | undefined>(
    initialQuery && initialQuery.trim().length > 0 ? initialQuery.trim() : undefined,
  );
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
          placeholderTextColor={colors.textMuted}
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
        <ActivityIndicator size="large" color={colors.primary} style={styles.centeredLoader} />
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

export function SearchScreen({ navigation, route }: Props) {
  const location = useDeviceLocation();
  const initialQuery = route.params?.initialQuery;

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Location: loading */}
      {location.status === "loading" ? (
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color={colors.primary} />
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
          initialQuery={initialQuery}
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
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
  },
  searchBoxWrapper: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  searchBox: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md - 2,
    fontSize: type.body.fontSize,
    color: colors.text,
  },
  filterBar: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md - 2,
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
  clearFiltersButton: {
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.pill,
  },
  clearFiltersText: {
    fontSize: 14,
    color: colors.primary,
    fontWeight: "600",
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
