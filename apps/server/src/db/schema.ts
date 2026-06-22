/**
 * Drizzle schema — Milestone 4: Orders & Payments.
 *
 * M3 added:
 *   - `listingCategory` and `listingUnit` pgEnums matching shared contracts exactly.
 *   - `locations`: one-per-store, PostGIS geography(Point,4326) with a GiST index.
 *   - `listings`: product listings belonging to a store.
 *
 * M4 adds:
 *   - `orderStatusEnum`, `orders`, `orderItems`: payment backbone.
 *   - Stripe Connect fields on `stores`: `stripeConnectAccountId`, `chargesEnabled`,
 *     `payoutsEnabled`, `detailsSubmitted`.
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
  boolean,
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

export const orderStatusEnum = pgEnum("order_status", [
  "pending_payment",
  "paid",
  "fulfilled",
  "cancelled",
  "refunded",
  "disputed",
]);

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
  /** Stripe connected account id (acct_…); set during Connect Express onboarding. */
  stripeConnectAccountId: text("stripe_connect_account_id").unique(),
  /** Whether the connected account can accept charges. Kept fresh by account.updated webhook. */
  chargesEnabled: boolean("charges_enabled").notNull().default(false),
  /** Whether the connected account can receive payouts. Kept fresh by account.updated webhook. */
  payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
  /** Whether the seller has submitted their Connect details. Kept fresh by account.updated webhook. */
  detailsSubmitted: boolean("details_submitted").notNull().default(false),
  /**
   * Platform-protection ledger: tracks cents owed by the platform to the seller
   * (or owed to the platform from the seller) when a refund or dispute reverse-transfer
   * cannot be fully recovered from an empty connected-account balance. Positive = platform
   * owes the seller; negative = seller owes the platform. Settled out-of-band or via
   * future payouts sweeper.
   */
  amountOwedCents: integer("amount_owed_cents").notNull().default(0),
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

// ---------------------------------------------------------------------------
// Orders — M4 payment backbone
// Money is always integer cents. Status truth comes from Stripe webhooks.
// ---------------------------------------------------------------------------

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    buyerId: uuid("buyer_id")
      .notNull()
      .references(() => users.id),
    status: orderStatusEnum("status").notNull().default("pending_payment"),
    subtotalCents: integer("subtotal_cents").notNull(),
    applicationFeeCents: integer("application_fee_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    /** Stripe PaymentIntent id — set after PI creation; used for webhook dispatch. */
    stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
    /** Running total of refunded cents. Accumulates on partial refunds; order
     *  flips to "refunded" only when refundedCents reaches totalCents. */
    refundedCents: integer("refunded_cents").notNull().default(0),
    /** Set when the buyer submits a refund request; null until requested. */
    refundRequestedAt: timestamp("refund_requested_at", { withTimezone: true }),
    /** Free-text reason supplied by the buyer at refund-request time; null if not provided. */
    refundReason: text("refund_reason"),
    /** Set when the seller approves the refund; null until approved. */
    refundApprovedAt: timestamp("refund_approved_at", { withTimezone: true }),
    /** Set when the seller declines the refund request; null until declined. Cleared when buyer re-requests. */
    refundDeclinedAt: timestamp("refund_declined_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orders_buyer_id_idx").on(t.buyerId),
    index("orders_store_id_idx").on(t.storeId),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id),
    /** Snapshot of the listing name at order time — immune to future edits. */
    nameSnapshot: text("name_snapshot").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    quantity: integer("quantity").notNull(),
    lineTotalCents: integer("line_total_cents").notNull(),
  },
  (t) => [index("order_items_order_id_idx").on(t.orderId)],
);

// ---------------------------------------------------------------------------
// Processed Stripe events — exactly-once webhook dedup table
// ---------------------------------------------------------------------------

/**
 * Records every Stripe event id that has been successfully processed.
 * Webhook handlers INSERT here (with ON CONFLICT DO NOTHING) before acting;
 * if the row already exists the event is a duplicate and the handler is a no-op.
 */
export const processedStripeEvents = pgTable("processed_stripe_events", {
  /** Stripe event.id (e.g. "evt_…"). Primary key = natural dedup key. */
  id: text("id").primaryKey(),
  /** Stripe event type (e.g. "payment_intent.succeeded") — for observability. */
  type: text("type").notNull(),
  /** Wall-clock time the event was first received by the webhook handler. */
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
