/**
 * Category → emoji mapping for the "Harvest Warm" theme, plus a small unit
 * label helper. Used by YourStand's setup journey/dashboard and its category
 * chips so listings read as warm and human rather than clinical.
 */

import type { ListingCategory, ListingUnit } from "@homegrown/shared";

export const CATEGORY_EMOJI: Record<ListingCategory, string> = {
  vegetable: "\u{1F96C}", // 🥬
  fruit: "\u{1F34E}", // 🍎
  herb: "\u{1F33F}", // 🌿
  egg: "\u{1F95A}", // 🥚
  honey: "\u{1F36F}", // 🍯
  other: "\u{1F9FA}", // 🧺
};

/** Returns the emoji for a listing category, falling back to the "other" basket. */
export function categoryEmoji(category: ListingCategory): string {
  return CATEGORY_EMOJI[category] ?? CATEGORY_EMOJI.other;
}

/**
 * Pluralizes a unit label for display next to a quantity, e.g. unitLabel(3, "bunch")
 * → "3 bunches". Only pluralizes the handful of units that need it; most units
 * ("each", "lb", "oz") read fine unchanged.
 */
export function unitLabel(quantity: number, unit: ListingUnit): string {
  if (quantity === 1) return unit;
  switch (unit) {
    case "bunch":
      return "bunches";
    case "dozen":
      return "dozens";
    case "jar":
      return "jars";
    case "pint":
      return "pints";
    case "quart":
      return "quarts";
    default:
      return unit;
  }
}
