/**
 * PlaceInfoCard — compact info card shown when a community-place map pin
 * (F-048) is tapped: type emoji + name, type label, address/hours if
 * present, and two actions — Directions (opens the platform maps app via
 * `Linking`) and a close ✕. Swaps in place when a different pin is tapped
 * (the caller just re-renders with a new `place`); closing is the caller's
 * job (✕ here, or tapping the map itself, wired in HomeScreen).
 *
 * Visual treatment follows GardenPostOverlay's precedent for map/media
 * overlays, but as an opaque `Card` (shadow="raised" since it floats over
 * the map) rather than a text-over-media scrim. The hairline border is a
 * local addition on top of Card — it separates the card from busy map tiles.
 *
 * "🧺 Offer to supply" CTA (F-049) — shown only when BOTH `place.acceptsOffers`
 * is true (the place has a linked buyer account to notify) AND the caller
 * passes `canOfferToSupply` (the signed-in user owns a store — HomeScreen
 * gates this via `trpc.stores.getMine`, the same query YourStandScreen uses).
 * When `acceptsOffers` is false, no CTA renders at all — never a disabled
 * button, per the F-049 spec. Opening the offer compose form is the caller's
 * job (`onOfferToSupply`), consistent with `onClose`/`handleDirections`.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { CommunityPlace, CommunityPlaceType } from "@homegrown/shared";
import { colors, radii, spacing, type } from "../theme";
import { Card } from "./Card";
import { Button } from "./Button";

const TYPE_LABEL: Record<CommunityPlaceType, string> = {
  farmers_market: "Farmers market",
  coop: "Co-op",
  health_food: "Health food",
};

const TYPE_EMOJI: Record<CommunityPlaceType, string> = {
  farmers_market: "\u{1F9FA}", // 🧺 — matches PlaceMarker's choice
  coop: "\u{1F6D2}", // 🛒
  health_food: "\u{1F957}", // 🥗
};

type Props = {
  place: CommunityPlace;
  onClose: () => void;
  /** True when the signed-in user owns a store (can offer to supply). */
  canOfferToSupply?: boolean;
  /** Opens the offer-mode compose form for this place. Required when `canOfferToSupply` is true. */
  onOfferToSupply?: () => void;
};

export function PlaceInfoCard({ place, onClose, canOfferToSupply = false, onOfferToSupply }: Props) {
  const handleDirections = () => {
    // Works on both iOS and Android — opens the destination in whichever
    // maps app (or browser) the device resolves the URL to; no platform
    // branching needed.
    const url = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
    void Linking.openURL(url);
  };

  return (
    <Card shadow="raised" style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title} numberOfLines={1}>
          {TYPE_EMOJI[place.type]} {place.name}
        </Text>
        <Pressable
          onPress={onClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Close"
        >
          <Ionicons name="close" size={18} color={colors.textMuted} />
        </Pressable>
      </View>

      <Text style={styles.typeLabel}>{TYPE_LABEL[place.type]}</Text>

      {place.address ? (
        <Text style={styles.detailText} numberOfLines={1}>
          {place.address}
        </Text>
      ) : null}

      {place.hoursText ? (
        <Text style={styles.detailText} numberOfLines={1}>
          {place.hoursText}
        </Text>
      ) : null}

      <Pressable
        style={styles.directionsButton}
        onPress={handleDirections}
        accessibilityRole="button"
        accessibilityLabel="Directions"
      >
        <Ionicons name="navigate-outline" size={16} color={colors.onPrimary} />
        <Text style={styles.directionsText}>Directions</Text>
      </Pressable>

      {place.acceptsOffers && canOfferToSupply ? (
        <Button
          title="🧺 Offer to supply"
          variant="secondary"
          onPress={() => onOfferToSupply?.()}
          style={styles.offerButton}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  // Surface/radius/padding/shadow come from Card; only the map-separating
  // hairline border and the internal row gap are local.
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
  title: {
    flex: 1,
    fontSize: type.section.fontSize,
    fontWeight: type.section.fontWeight,
    color: colors.text,
  },
  typeLabel: {
    fontSize: type.caption.fontSize,
    fontWeight: "600",
    color: colors.primary,
  },
  detailText: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
  },
  directionsButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    backgroundColor: colors.primary,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm - 2,
    marginTop: spacing.xs,
  },
  directionsText: {
    color: colors.onPrimary,
    fontSize: type.caption.fontSize,
    fontWeight: "600",
  },
  offerButton: {
    marginTop: spacing.xs,
  },
});
