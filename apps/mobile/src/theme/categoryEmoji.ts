/**
 * Category → emoji mapping for the "Garden Fresh" theme, plus a small unit
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
 * Produce-name → emoji for the Home "In season now" chips. Names match the
 * curated SEASONAL_PRODUCE calendar entries. Sticks to widely-supported
 * emoji (≤ Unicode 12 where possible) so older Android keyboards don't tofu;
 * anything unmapped falls back to a seedling.
 */
const PRODUCE_EMOJI: Record<string, string> = {
  Apples: "\u{1F34E}", // 🍎
  Asparagus: "\u{1F331}", // 🌱 (no asparagus emoji)
  Basil: "\u{1F33F}", // 🌿
  Blueberries: "\u{1FAD0}", // 🫐
  Broccoli: "\u{1F966}", // 🥦
  "Brussels Sprouts": "\u{1F96C}", // 🥬
  Cabbage: "\u{1F96C}", // 🥬
  Carrots: "\u{1F955}", // 🥕
  Cauliflower: "\u{1F966}", // 🥦
  Cherries: "\u{1F352}", // 🍒
  Citrus: "\u{1F34A}", // 🍊
  Corn: "\u{1F33D}", // 🌽
  Cranberries: "\u{1F352}", // 🍒
  Cucumbers: "\u{1F952}", // 🥒
  Eggplant: "\u{1F346}", // 🍆
  Grapes: "\u{1F347}", // 🍇
  Herbs: "\u{1F33F}", // 🌿
  Kale: "\u{1F96C}", // 🥬
  Leeks: "\u{1F9C5}", // 🧅
  Lettuce: "\u{1F96C}", // 🥬
  Melons: "\u{1F348}", // 🍈
  Peaches: "\u{1F351}", // 🍑
  Pears: "\u{1F350}", // 🍐
  Peas: "\u{1F331}", // 🌱 (pea-pod emoji is Unicode 15 — too new)
  Peppers: "\u{1F336}\u{FE0F}", // 🌶️
  Potatoes: "\u{1F954}", // 🥔
  Pumpkins: "\u{1F383}", // 🎃
  Radishes: "\u{1F331}", // 🌱 (no radish emoji)
  Rhubarb: "\u{1F331}", // 🌱
  Spinach: "\u{1F343}", // 🍃
  Strawberries: "\u{1F353}", // 🍓
  "Sweet Potatoes": "\u{1F360}", // 🍠
  Tomatoes: "\u{1F345}", // 🍅
  Turnips: "\u{1F955}", // 🥕 (root-veg stand-in)
  "Winter Squash": "\u{1F383}", // 🎃
  Zucchini: "\u{1F952}", // 🥒
};

/** Emoji for a seasonal produce name; unknown names get the 🌱 seedling. */
export function produceEmoji(name: string): string {
  return PRODUCE_EMOJI[name] ?? "\u{1F331}";
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
