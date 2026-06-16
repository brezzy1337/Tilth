/**
 * Drizzle schema — Milestone 3: Geo & Listings.
 *
 * Adds:
 *   - `listingCategory` and `listingUnit` pgEnums matching shared contracts exactly.
 *   - `locations`: one-per-store, PostGIS geography(Point,4326) with a GiST index.
 *   - `listings`: product listings belonging to a store.
 *
 * The `geog` column uses a Drizzle customType whose dataType() returns
 * "geography(Point,4326)". drizzle-kit generates a placeholder; the actual
 * migration is hand-augmented to add CREATE EXTENSION IF NOT EXISTS postgis
 * and the GiST index.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  customType,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// PostGIS geography custom type
// ---------------------------------------------------------------------------

/**
 * A Drizzle customType that maps to PostGIS `geography(Point,4326)`.
 * The JS-side value is stored/retrieved as a raw string from Postgres
 * (WKB hex or the ST_AsText representation); callers use ST_X/ST_Y/ST_AsText
 * in raw SQL to extract lat/lng — they never parse this value in JS.
 */
export const geography = customType<{ data: string }>({
  dataType() {
    return "geography(Point,4326)";
  },
});

// ---------------------------------------------------------------------------
// Enums — must match shared contracts exactly
// ---------------------------------------------------------------------------

export const listingCategoryEnum = pgEnum("listing_category", [
  "vegetable",
  "fruit",
  "herb",
  "egg",
  "honey",
  "other",
]);

export const listingUnitEnum = pgEnum("listing_unit", [
  "each",
  "lb",
  "oz",
  "bunch",
  "dozen",
  "jar",
  "pint",
  "quart",
]);

// ---------------------------------------------------------------------------
// Users (unchanged from M2)
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique().notNull(),
  username: text("username").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// Stores (unchanged from M2)
// ---------------------------------------------------------------------------

export const stores = pgTable("stores", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  name: text("name").notNull(),
  logo: text("logo"),
  about: text("about"),
  stripeConnectAccountId: text("stripe_connect_account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ---------------------------------------------------------------------------
// Locations — one per store, PostGIS geography point
// ---------------------------------------------------------------------------

export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .unique()
      .references(() => stores.id),
    address: text("address").notNull(),
    city: text("city").notNull(),
    state: text("state").notNull(),
    zip: text("zip").notNull(),
    /** PostGIS geography(Point,4326) — never parsed JS-side; use ST_X/ST_Y. */
    geog: geography("geog").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("locations_geog_idx").using("gist", t.geog)],
);

// ---------------------------------------------------------------------------
// Listings — produce items belonging to a store
// ---------------------------------------------------------------------------

export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    name: text("name").notNull(),
    category: listingCategoryEnum("category").notNull(),
    priceCents: integer("price_cents").notNull(),
    quantity: integer("quantity").notNull(),
    unit: listingUnitEnum("unit").notNull(),
    /** Optional JSONB extras, e.g. { dried: true } for herbs. */
    attributes: jsonb("attributes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("listings_store_id_idx").on(t.storeId)],
);
