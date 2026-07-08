/**
 * ListingCard — shared produce listing card used by HomeScreen, SearchScreen,
 * and StoreProfileScreen.
 *
 * Shows: category emoji, name, category, price/unit, optionally distance,
 * optionally store name, and an Add/Sold-out button with brief "Added"
 * feedback. Handles the single-store cart prompt (Alert) when the user taps
 * Add on a listing from a different store.
 *
 * storeName and distanceKm are optional — they are present on NearbyListing
 * (Home/Search) but absent on Listing (store catalog). The card renders them
 * only when provided.
 *
 * When onPressStore is provided AND storeName is present, the store name is
 * rendered as a tappable Pressable so buyers can navigate to the store profile.
 *
 * Restyled to "Garden Fresh" tokens (F-044) — Card primitive, category emoji
 * leading the row, warm colors throughout.
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import type { ListingCategory, ListingUnit } from "@homegrown/shared";
import { useCart } from "../cart/CartContext";
import { capitalise } from "../utils/text";
import { formatCents } from "../utils/money";
import { Card } from "./Card";
import { colors, radii, spacing, type } from "../theme";
import { categoryEmoji } from "../theme/categoryEmoji";

/**
 * Minimal item shape the card needs. Both NearbyListing (Home/Search) and
 * Listing (store catalog) structurally satisfy this interface.
 */
export type ListingCardItem = {
  id: string;
  name: string;
  category: ListingCategory;
  priceCents: number;
  quantity: number;
  unit: ListingUnit;
  storeId: string;
  /** Present on NearbyListing; absent on store-catalog Listing. */
  storeName?: string;
  /** Present on NearbyListing (computed by ST_Distance); absent on store-catalog Listing. */
  distanceKm?: number;
};

type Props = {
  item: ListingCardItem;
  /**
   * When provided AND item.storeName is present, the store name is rendered as
   * a tappable Pressable that calls this handler (navigate to store profile).
   * When not provided the store name is rendered as plain text (or omitted if
   * storeName is also absent).
   */
  onPressStore?: () => void;
};

export function ListingCard({ item, onPressStore }: Props) {
  const [justAdded, setJustAdded] = useState(false);
  const { addItem, clearCart } = useCart();

  function handleAdd() {
    const result = addItem(item);
    if (result.ok) {
      setJustAdded(true);
      setTimeout(() => setJustAdded(false), 1500);
    } else if (result.reason === "different-store") {
      Alert.alert(
        "Start a new cart?",
        `Your cart has items from ${result.cartStoreName}. Starting a new cart will remove them.\n\nSwitch to ${item.storeName ?? item.storeId}?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Start new cart",
            style: "destructive",
            onPress: () => {
              clearCart();
              const retry = addItem(item);
              if (retry.ok) {
                setJustAdded(true);
                setTimeout(() => setJustAdded(false), 1500);
              }
            },
          },
        ],
      );
    }
  }

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.emoji}>{categoryEmoji(item.category)}</Text>
        <Text style={styles.name}>{item.name}</Text>
        {item.distanceKm !== undefined ? (
          <Text style={styles.distance}>{item.distanceKm.toFixed(1)} km</Text>
        ) : null}
      </View>
      <Text style={styles.price}>
        ${formatCents(item.priceCents)} / {item.unit}
      </Text>
      {item.quantity > 0 ? (
        <Text style={styles.availability}>
          {item.quantity} {item.unit} available
        </Text>
      ) : (
        <Text style={styles.soldOut}>Sold out</Text>
      )}
      {item.storeName !== undefined ? (
        <Text style={styles.meta}>
          {capitalise(item.category)} ·{" "}
          {onPressStore ? (
            <Text style={styles.storeLink} onPress={onPressStore}>
              {item.storeName}
            </Text>
          ) : (
            item.storeName
          )}
        </Text>
      ) : (
        <Text style={styles.meta}>{capitalise(item.category)}</Text>
      )}
      <Pressable
        style={[styles.addButton, justAdded ? styles.addButtonAdded : null]}
        onPress={handleAdd}
        disabled={item.quantity === 0}
      >
        <Text style={styles.addButtonText}>
          {item.quantity === 0 ? "Sold out" : justAdded ? "Added" : "Add"}
        </Text>
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  emoji: {
    fontSize: 18,
    marginRight: spacing.sm,
  },
  name: {
    fontSize: type.body.fontSize + 1,
    fontWeight: "600",
    color: colors.text,
    flex: 1,
  },
  distance: {
    fontSize: type.caption.fontSize,
    color: colors.primary,
    fontWeight: "500",
    marginLeft: spacing.sm,
  },
  price: {
    fontSize: type.body.fontSize,
    color: colors.primary,
    fontWeight: "700",
    marginBottom: spacing.xs,
  },
  availability: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  soldOut: {
    fontSize: type.caption.fontSize,
    color: colors.danger,
    fontWeight: "600",
    marginBottom: spacing.xs,
  },
  meta: {
    fontSize: 12,
    color: colors.textMuted,
  },
  storeLink: {
    fontSize: 12,
    color: colors.primary,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
  addButton: {
    marginTop: spacing.md,
    alignSelf: "flex-start",
    backgroundColor: colors.primary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
  },
  addButtonAdded: {
    backgroundColor: colors.secondary,
  },
  addButtonText: {
    color: colors.onPrimary,
    fontSize: 13,
    fontWeight: "600",
  },
});
