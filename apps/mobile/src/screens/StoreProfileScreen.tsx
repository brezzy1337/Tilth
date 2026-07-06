/**
 * StoreProfileScreen — buyer-facing public store page.
 *
 * Shows the store header (name, logo, about) followed by a catalog of all
 * the store's current listings as ListingCard rows. Buyers can add items to
 * the cart directly from this screen.
 *
 * Route params: { storeId: string; storeName?: string }
 *   storeId   — UUID of the store to display.
 *   storeName — optional display name passed from the caller (used as a
 *               placeholder heading while the profile query loads).
 *
 * Data:
 *   trpc.stores.get({ storeId })         → StoreProfile header data
 *   trpc.listings.listByStore({ storeId }) → Listing[] catalog rows
 *
 * States: loading (spinner), error + retry, empty catalog notice.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import { trpc } from "../api/trpc";
import type { AuthedStackParamList } from "../navigation/types";
import { ListingCard } from "../components/ListingCard";
import type { Listing, TrustTier } from "@homegrown/shared";

type Props = NativeStackScreenProps<AuthedStackParamList, "StoreProfile">;

// ---------------------------------------------------------------------------
// Trust badge — tier → icon color / chip tint / label lookup (F-016)
// ---------------------------------------------------------------------------

const TRUST_TIER_STYLE: Record<TrustTier, { color: string; tint: string; label: string }> = {
  gold: { color: "#D4AF37", tint: "#D4AF3726", label: "Gold seller" },
  silver: { color: "#8E8E93", tint: "#8E8E9326", label: "Silver seller" },
  bronze: { color: "#CD7F32", tint: "#CD7F3226", label: "Bronze seller" },
};

function TrustBadge({ tier }: { tier: TrustTier }) {
  const tierStyle = TRUST_TIER_STYLE[tier];
  if (!tierStyle) return null;

  return (
    <View
      style={[styles.trustBadge, { backgroundColor: tierStyle.tint }]}
      accessibilityRole="image"
      accessibilityLabel={`${
        tier.charAt(0).toUpperCase() + tier.slice(1)
      } tier seller, high order fulfillment rate`}
    >
      <Ionicons name="ribbon" size={14} color={tierStyle.color} />
      <Text style={[styles.trustBadgeText, { color: tierStyle.color }]}>
        {tierStyle.label}
      </Text>
    </View>
  );
}

export function StoreProfileScreen({ route }: Props) {
  const { storeId, storeName: fallbackName } = route.params;

  const {
    data: profile,
    isLoading: profileLoading,
    error: profileError,
    refetch: refetchProfile,
  } = trpc.stores.get.useQuery({ storeId });

  const {
    data: listings,
    isLoading: listingsLoading,
    error: listingsError,
    refetch: refetchListings,
  } = trpc.listings.listByStore.useQuery({ storeId });

  const isLoading = profileLoading || listingsLoading;
  const hasError = profileError ?? listingsError;

  function handleRetry() {
    if (profileError) void refetchProfile();
    if (listingsError) void refetchListings();
  }

  // ---------------------------------------------------------------------------
  // Loading splash
  // ---------------------------------------------------------------------------

  if (isLoading && !profile) {
    return (
      <SafeAreaView style={styles.safeArea}>
        {fallbackName ? (
          <View style={styles.headerPlaceholder}>
            <Text style={styles.storeName}>{fallbackName}</Text>
          </View>
        ) : null}
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color="#2d6a4f" />
        </View>
      </SafeAreaView>
    );
  }

  // ---------------------------------------------------------------------------
  // Error state
  // ---------------------------------------------------------------------------

  if (hasError && !profile) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>
            Could not load store: {(profileError ?? listingsError)?.message}
          </Text>
          <Pressable style={styles.retryButton} onPress={handleRetry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ---------------------------------------------------------------------------
  // Store header + catalog
  // ---------------------------------------------------------------------------

  const displayName = profile?.name ?? fallbackName ?? "Stand";

  return (
    <SafeAreaView style={styles.safeArea}>
      <FlatList<Listing>
        data={listings ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <>
            {/* Store header */}
            <View style={styles.storeHeader}>
              {/* Defense-in-depth: only render an https logo URL, so a non-https /
                  javascript: / data: value (which z.string().url() would accept)
                  can't reach <Image>. */}
              {profile?.logo && /^https:\/\//i.test(profile.logo) ? (
                <Image
                  source={{ uri: profile.logo }}
                  style={styles.logo}
                  accessibilityLabel={`${displayName} logo`}
                  resizeMode="cover"
                />
              ) : null}
              <Text style={styles.storeName}>{displayName}</Text>
              {profile?.trustTier ? <TrustBadge tier={profile.trustTier} /> : null}
              {profile?.about ? (
                <Text style={styles.about}>{profile.about}</Text>
              ) : null}
            </View>

            {/* Catalog header row */}
            <Text style={styles.catalogHeading}>Listings</Text>

            {/* Listings error — show inline if profile loaded OK */}
            {listingsError ? (
              <View style={styles.inlineError}>
                <Text style={styles.stateText}>
                  Could not load listings: {listingsError.message}
                </Text>
                <Pressable
                  style={styles.retryButton}
                  onPress={() => void refetchListings()}
                >
                  <Text style={styles.retryText}>Retry</Text>
                </Pressable>
              </View>
            ) : null}

            {/* Listings loading indicator (profile already shown) */}
            {listingsLoading ? (
              <ActivityIndicator
                size="small"
                color="#2d6a4f"
                style={styles.listingsLoader}
              />
            ) : null}

            {/* Empty state */}
            {!listingsLoading &&
            !listingsError &&
            listings !== undefined &&
            listings.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.stateText}>
                  This stand has no listings yet.
                </Text>
              </View>
            ) : null}
          </>
        }
        renderItem={({ item }) => (
          // NO onPressStore — we're already on the store page; Listing has no
          // storeName/distanceKm so the card renders only name, category, price.
          <ListingCard item={item} />
        )}
      />
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
  headerPlaceholder: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#e8eae8",
  },
  storeHeader: {
    backgroundColor: "#fff",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e8eae8",
  },
  logo: {
    width: 80,
    height: 80,
    borderRadius: 40,
    marginBottom: 12,
    backgroundColor: "#e8eae8",
  },
  storeName: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#1a1a1a",
    marginBottom: 6,
  },
  about: {
    fontSize: 14,
    color: "#555",
    lineHeight: 20,
  },
  trustBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 8,
  },
  trustBadgeText: {
    fontSize: 12,
    fontWeight: "700",
  },
  catalogHeading: {
    fontSize: 16,
    fontWeight: "700",
    color: "#2d6a4f",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  listContent: {
    paddingBottom: 32,
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  inlineError: {
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 16,
    gap: 12,
  },
  emptyState: {
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  stateText: {
    fontSize: 16,
    color: "#444",
    textAlign: "center",
    fontWeight: "600",
  },
  listingsLoader: {
    marginVertical: 16,
  },
  retryButton: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2d6a4f",
  },
  retryText: {
    color: "#2d6a4f",
    fontSize: 14,
    fontWeight: "600",
  },
});
