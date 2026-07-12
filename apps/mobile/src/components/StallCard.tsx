/**
 * StallCard — Home sheet row for a grower's stall (F-050: stall-first Home).
 *
 * Sibling to ListingCard, but a stall (not a single listing) is the row: name
 * up top, a row of up to 6 produce-category emoji (the stall's current
 * `listings.nearby` categories, `CATEGORY_EMOJI`, 18px — same size as the map's
 * `StallMarker` badge) with a "+N" overflow count past that, a listing-count
 * line ("N items"), and distance (computed server-side per listing via
 * ST_Distance; HomeScreen takes the stall's minimum across its listings). The
 * whole row is one tap target that navigates to the store profile, where
 * add-to-cart already lives — produce is no longer added from this list.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ListingCategory } from "@homegrown/shared";
import { Card } from "./Card";
import { colors, spacing, type } from "../theme";
import { CATEGORY_EMOJI } from "../theme/categoryEmoji";

const MAX_VISIBLE_CATEGORIES = 6;

/** Minimal per-stall shape the card needs — see HomeScreen's `stallMarkers`. */
export type StallCardItem = {
  storeId: string;
  storeName: string;
  /** Ordered per the shared enum (`listingCategory.options`), deduped. */
  categories: ListingCategory[];
  listingCount: number;
  /** Kilometres — the stall's nearest listing (min of per-listing distanceKm). */
  distanceKm: number;
};

type Props = {
  item: StallCardItem;
  onPress: () => void;
};

export function StallCard({ item, onPress }: Props) {
  const visible = item.categories.slice(0, MAX_VISIBLE_CATEGORIES);
  const overflow = item.categories.length - visible.length;
  const itemsLabel = item.listingCount === 1 ? "1 item" : `${item.listingCount} items`;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.storeName}, ${itemsLabel}`}
    >
      <Card style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.name}>{item.storeName}</Text>
          <Text style={styles.distance}>{item.distanceKm.toFixed(1)} km</Text>
        </View>
        <View style={styles.categoryRow}>
          {visible.map((cat) => (
            <Text key={cat} style={styles.categoryEmoji}>
              {CATEGORY_EMOJI[cat]}
            </Text>
          ))}
          {overflow > 0 ? <Text style={styles.overflow}>{`+${overflow}`}</Text> : null}
        </View>
        <Text style={styles.meta}>{itemsLabel}</Text>
      </Card>
    </Pressable>
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
  categoryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  categoryEmoji: {
    fontSize: 18,
  },
  overflow: {
    fontSize: type.label.fontSize,
    fontWeight: type.label.fontWeight,
    color: colors.primary,
    marginLeft: 2,
  },
  meta: {
    fontSize: 12,
    color: colors.textMuted,
  },
});
