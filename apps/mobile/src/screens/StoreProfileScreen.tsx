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
import { colors, radii, spacing, type } from "../theme";

type Props = NativeStackScreenProps<AuthedStackParamList, "StoreProfile">;

// ---------------------------------------------------------------------------
// Trust badge — tier → icon color / chip tint / label lookup (F-016)
//
// Gold/Silver/Bronze hues stay recognizable (not theme tokens — no metal
// tones exist in the palette) but the tints are kept soft (low-opacity via
// hex alpha suffix) to harmonize with the warm background instead of reading
// as saturated blocks.
// ---------------------------------------------------------------------------

const TRUST_TIER_STYLE: Record<TrustTier, { color: string; tint: string; label: string }> = {
  gold: { color: "#D4AF37", tint: "#D4AF3720", label: "Gold seller" },
  silver: { color: "#8E8E93", tint: "#8E8E9320", label: "Silver seller" },
  bronze: { color: "#CD7F32", tint: "#CD7F3220", label: "Bronze seller" },
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
          <ActivityIndicator size="large" color={colors.primary} />
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
                color={colors.primary}
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
    backgroundColor: colors.bg,
  },
  headerPlaceholder: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  storeHeader: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    marginBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  logo: {
    width: 80,
    height: 80,
    borderRadius: 40,
    marginBottom: spacing.md,
    backgroundColor: colors.surfaceAlt,
  },
  storeName: {
    fontSize: type.title.fontSize,
    fontWeight: type.title.fontWeight,
    color: colors.text,
    marginBottom: spacing.sm - 2,
  },
  about: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
    lineHeight: 20,
  },
  trustBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
    marginBottom: spacing.sm,
  },
  trustBadgeText: {
    fontSize: 12,
    fontWeight: "700",
  },
  catalogHeading: {
    fontSize: type.section.fontSize,
    fontWeight: type.section.fontWeight,
    color: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  listContent: {
    paddingBottom: spacing.xxxl,
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxxl,
    gap: spacing.md,
  },
  inlineError: {
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    gap: spacing.md,
  },
  emptyState: {
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xxl,
  },
  stateText: {
    fontSize: 16,
    color: colors.text,
    textAlign: "center",
    fontWeight: "600",
  },
  listingsLoader: {
    marginVertical: spacing.lg,
  },
  retryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  retryText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: "600",
  },
});
