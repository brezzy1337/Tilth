/**
 * SourcingScreen — sourcing home for community-place buyers (F-049). Only
 * reachable from HomeScreen's "🧺 Sourcing for {placeName}" entry banner,
 * itself gated on `places.mine` being non-null (the signed-in user is a
 * linked place buyer). Growers/sellers do NOT get this screen in v1 — their
 * requests/offers surface via chat request cards only (ConversationScreen).
 *
 * Two sections:
 *   "Nearby growers" — `sourcing.growers` (place-linked callers only; this
 *     screen's precondition guarantees that), using the same device-location
 *     acquisition HomeScreen/GardenFeedScreen already use. Each row has a
 *     "Request produce" button that pushes SourcingComposeScreen in request
 *     mode.
 *   "My requests" — `sourcing.listMine`. Since this screen is place-buyer
 *     only, every row's counterparty is always the grower (storeName) —
 *     both directions (a request this place sent, or an offer a grower sent
 *     this place) put the place on the same side, so no direction branch is
 *     needed for the "who's the other party" label here (unlike
 *     ConversationScreen's request card, which is read by both sides).
 *     Tapping a row opens its conversation.
 *
 * Pull-to-refresh refetches both queries. Loading spinners follow the app's
 * existing centered-state convention.
 *
 * React Native only — no DOM elements.
 */

import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Image,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { SourcingGrowerSummary, SourcingRequest } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useDeviceLocation } from "../location/useDeviceLocation";
import type { AuthedNavigationProp } from "../navigation/types";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { SectionHeader } from "../components/SectionHeader";
import { SourcingStatusChip } from "../components/SourcingStatusChip";
import { colors, radii, spacing, type } from "../theme";
import { formatIsoDateShort } from "../utils/time";

const RADIUS_KM = 25;

// ---------------------------------------------------------------------------
// GrowerRow
// ---------------------------------------------------------------------------

function GrowerRow({
  grower,
  onRequestProduce,
}: {
  grower: SourcingGrowerSummary;
  onRequestProduce: () => void;
}) {
  return (
    <Card variant="tint" flat style={styles.growerRow}>
      <View style={styles.growerRowTop}>
        {grower.logo ? (
          <Image source={{ uri: grower.logo }} style={styles.growerLogo} />
        ) : (
          <View style={styles.growerLogoPlaceholder}>
            <Text style={styles.growerLogoEmoji}>🌱</Text>
          </View>
        )}
        <View style={styles.growerInfo}>
          <Text style={styles.growerName} numberOfLines={1}>
            {grower.name}
          </Text>
          <Text style={styles.growerMeta}>
            {grower.distanceKm.toFixed(1)} km · {grower.listingCount}{" "}
            {grower.listingCount === 1 ? "listing" : "listings"}
          </Text>
          {grower.sampleListings.length > 0 ? (
            <Text style={styles.growerSample} numberOfLines={1}>
              {grower.sampleListings.join(" · ")}
            </Text>
          ) : null}
        </View>
      </View>
      <Button
        title="Request produce"
        variant="secondary"
        fullWidth={false}
        onPress={onRequestProduce}
        style={styles.requestButton}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// MyRequestRow
// ---------------------------------------------------------------------------

function MyRequestRow({ item, onPress }: { item: SourcingRequest; onPress: () => void }) {
  const neededByLabel = item.direction === "place_to_grower" ? "Needed by" : "Available by";
  return (
    <Card variant="tint" flat style={styles.requestRow}>
      <View style={styles.requestRowTop}>
        <View style={styles.requestRowInfo}>
          <Text style={styles.requestProduce} numberOfLines={1}>
            {item.quantity} of {item.produce}
          </Text>
          <Text style={styles.requestCounterparty} numberOfLines={1}>
            {item.storeName}
          </Text>
          {item.neededBy ? (
            <Text style={styles.requestMeta}>
              {neededByLabel} {formatIsoDateShort(item.neededBy)}
            </Text>
          ) : null}
        </View>
        <SourcingStatusChip status={item.status} />
      </View>
      <Button
        title="Open conversation"
        variant="ghost"
        fullWidth={false}
        onPress={onPress}
        style={styles.openConversationButton}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SourcingScreen
// ---------------------------------------------------------------------------

export function SourcingScreen() {
  const navigation = useNavigation<AuthedNavigationProp>();
  const location = useDeviceLocation();
  const [refreshing, setRefreshing] = useState(false);

  const { data: place } = trpc.places.mine.useQuery();

  const hasCoords = location.status === "granted" && location.coords !== undefined;
  const lat = location.coords?.lat ?? 0;
  const lng = location.coords?.lng ?? 0;

  const {
    data: growers,
    isLoading: growersLoading,
    error: growersError,
    refetch: refetchGrowers,
  } = trpc.sourcing.growers.useQuery({ lat, lng, radiusKm: RADIUS_KM }, { enabled: hasCoords });

  const {
    data: myRequests,
    isLoading: myRequestsLoading,
    error: myRequestsError,
    refetch: refetchMyRequests,
  } = trpc.sourcing.listMine.useQuery();

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refetchGrowers(), refetchMyRequests()]);
    } finally {
      setRefreshing(false);
    }
  }, [refetchGrowers, refetchMyRequests]);

  function openConversation(item: SourcingRequest) {
    navigation.navigate("Conversation", { conversationId: item.conversationId });
  }

  function openComposeForGrower(grower: SourcingGrowerSummary) {
    navigation.navigate("SourcingCompose", {
      mode: "request",
      storeId: grower.storeId,
      storeName: grower.name,
    });
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void handleRefresh()} tintColor={colors.primary} />
        }
      >
        <SectionHeader
          emoji="🧺"
          title={place ? `Sourcing for ${place.name}` : "Sourcing"}
          subtitle="Ask growers to supply produce for your shelves."
          tint={colors.primarySoft}
          iconColor={colors.primary}
          size="title"
        />

        {/* Nearby growers */}
        <View style={styles.section}>
          <SectionHeader emoji="🌱" title="Nearby growers" />

          {location.status === "loading" || (hasCoords && growersLoading) ? (
            <ActivityIndicator size="large" color={colors.primary} style={styles.loader} />
          ) : null}

          {location.status === "denied" ? (
            <Text style={styles.stateSubText}>
              Enable location permissions in Settings to see growers nearby.
            </Text>
          ) : null}

          {location.status === "error" ? (
            <View>
              <Text style={styles.stateSubText}>Could not determine your location.</Text>
              <Button title="Retry" variant="ghost" fullWidth={false} onPress={() => void refetchGrowers()} />
            </View>
          ) : null}

          {growersError ? (
            <View>
              <Text style={styles.serverError}>Could not load growers: {growersError.message}</Text>
              <Button title="Retry" variant="ghost" fullWidth={false} onPress={() => void refetchGrowers()} />
            </View>
          ) : null}

          {hasCoords && !growersLoading && !growersError && growers && growers.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyEmoji}>🌾</Text>
              <Text style={styles.stateText}>No growers nearby yet</Text>
              <Text style={styles.stateSubText}>Check back soon as more stands open near you.</Text>
            </View>
          ) : null}

          {growers?.map((grower) => (
            <GrowerRow key={grower.storeId} grower={grower} onRequestProduce={() => openComposeForGrower(grower)} />
          ))}
        </View>

        {/* My requests */}
        <View style={styles.section}>
          <SectionHeader emoji="📋" title="My requests" />

          {myRequestsLoading ? (
            <ActivityIndicator size="large" color={colors.primary} style={styles.loader} />
          ) : null}

          {myRequestsError ? (
            <View>
              <Text style={styles.serverError}>Could not load requests: {myRequestsError.message}</Text>
              <Button title="Retry" variant="ghost" fullWidth={false} onPress={() => void refetchMyRequests()} />
            </View>
          ) : null}

          {!myRequestsLoading && !myRequestsError && myRequests && myRequests.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyEmoji}>🧺</Text>
              <Text style={styles.stateText}>No requests yet</Text>
              <Text style={styles.stateSubText}>
                Request produce from a nearby grower above and it'll show up here.
              </Text>
            </View>
          ) : null}

          {myRequests?.map((item) => (
            <MyRequestRow key={item.id} item={item} onPress={() => openConversation(item)} />
          ))}
        </View>
      </ScrollView>
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
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxxl * 1.5,
    gap: spacing.xl,
  },
  section: {
    gap: spacing.md,
  },
  loader: {
    marginTop: spacing.lg,
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: spacing.xxl,
    gap: spacing.xs,
  },
  emptyEmoji: {
    fontSize: 40,
    marginBottom: spacing.xs,
  },
  stateText: {
    fontSize: type.body.fontSize,
    color: colors.text,
    fontWeight: "600",
    textAlign: "center",
  },
  stateSubText: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    textAlign: "center",
  },
  serverError: {
    fontSize: type.caption.fontSize,
    color: colors.danger,
    textAlign: "center",
    marginBottom: spacing.sm,
  },
  // Grower row
  growerRow: {
    gap: spacing.sm,
  },
  growerRowTop: {
    flexDirection: "row",
    gap: spacing.md,
  },
  growerLogo: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
  },
  growerLogoPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  growerLogoEmoji: {
    fontSize: 20,
  },
  growerInfo: {
    flex: 1,
    justifyContent: "center",
  },
  growerName: {
    fontSize: type.body.fontSize,
    fontWeight: "700",
    color: colors.text,
  },
  growerMeta: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginTop: 2,
  },
  growerSample: {
    fontSize: type.caption.fontSize,
    color: colors.primary,
    marginTop: 2,
  },
  requestButton: {
    alignSelf: "flex-start",
  },
  // My-request row
  requestRow: {
    gap: spacing.sm,
  },
  requestRowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  requestRowInfo: {
    flex: 1,
  },
  requestProduce: {
    fontSize: type.body.fontSize,
    fontWeight: "700",
    color: colors.text,
  },
  requestCounterparty: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginTop: 2,
  },
  requestMeta: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginTop: 2,
  },
  openConversationButton: {
    alignSelf: "flex-start",
  },
});
