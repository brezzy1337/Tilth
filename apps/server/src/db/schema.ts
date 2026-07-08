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
  real,
  jsonb,
  pgEnum,
  customType,
  index,
  boolean,
  uniqueIndex,
  primaryKey,
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

export const orderFulfillmentMethodEnum = pgEnum("order_fulfillment_method", [
  "pickup",
  "delivery",
]);

/**
 * F-029 — orthogonal operational sub-state for a 'paid' order (packing/prep progress).
 * Progresses null → packing → ready. Moves NO money; independent of orderStatusEnum.
 */
export const orderPreparationStateEnum = pgEnum("order_preparation_state", [
  "packing",
  "ready",
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
    /** F-029 — orthogonal packing/prep sub-state for 'paid' orders. Null = not started. */
    preparationState: orderPreparationStateEnum("preparation_state"),
    subtotalCents: integer("subtotal_cents").notNull(),
    applicationFeeCents: integer("application_fee_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    /** Stripe PaymentIntent id — set after PI creation; used for webhook dispatch. */
    stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
    /** How the buyer receives the order. Defaults to pickup so existing rows are valid. */
    fulfillmentMethod: orderFulfillmentMethodEnum("fulfillment_method")
      .notNull()
      .default("pickup"),
    /** Delivery address supplied by the buyer; null for pickup orders. */
    deliveryAddress: text("delivery_address"),
    /** Optional tip in cents paid by the buyer; goes 100% to the seller.
     *  The platform's 10% application fee is computed on subtotalCents only — the
     *  tip is NEVER included in the fee base. */
    tipCents: integer("tip_cents").notNull().default(0),
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
// Garden posts — F-047 stories/reels feed (photo sets + short Mux-hosted video)
// ---------------------------------------------------------------------------

export const gardenPostTypeEnum = pgEnum("garden_post_type", ["photo_set", "video"]);

/**
 * DB-level status includes 'errored' (a video whose Mux upload/asset failed),
 * but the shared `gardenPostStatus` contract only knows 'processing' | 'ready' —
 * 'errored' posts are filtered out of `garden.feed` and never reach the client.
 */
export const gardenPostStatusEnum = pgEnum("garden_post_status", [
  "processing",
  "ready",
  "errored",
]);

export const gardenPosts = pgTable(
  "garden_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    type: gardenPostTypeEnum("type").notNull(),
    status: gardenPostStatusEnum("status").notNull().default("processing"),
    caption: text("caption").notNull().default(""),
    /** Photo-set posts only: array of { url, width?, height? }. Null for video posts. */
    photos: jsonb("photos"),
    /** Video posts only — Mux direct-upload id, set at createVideo time. */
    muxUploadId: text("mux_upload_id"),
    /** Video posts only — Mux asset id, set once the webhook confirms encoding. */
    muxAssetId: text("mux_asset_id"),
    /** Video posts only — first public playback id, set by the video.asset.ready webhook. */
    muxPlaybackId: text("mux_playback_id"),
    /** Video posts only — duration in seconds, from the video.asset.ready webhook payload. */
    durationS: real("duration_s"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("garden_posts_store_id_idx").on(t.storeId),
    // Keyset pagination for the recency feed: ORDER BY created_at DESC, id DESC.
    index("garden_posts_created_at_id_idx").on(t.createdAt.desc(), t.id.desc()),
  ],
);

// ---------------------------------------------------------------------------
// Processed Mux events — exactly-once webhook dedup table (mirrors Stripe's)
// ---------------------------------------------------------------------------

export const processedMuxEvents = pgTable("processed_mux_events", {
  /** Mux event.id. Primary key = natural dedup key. */
  id: text("id").primaryKey(),
  /** Mux event type (e.g. "video.asset.ready") — for observability. */
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

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

// ---------------------------------------------------------------------------
// Messaging — F-037/F-038 1:1 buyer<->store conversations + moderation + push
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    buyerId: uuid("buyer_id")
      .notNull()
      .references(() => users.id),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    /** Last time the buyer read this conversation; null = never. */
    buyerLastReadAt: timestamp("buyer_last_read_at", { withTimezone: true }),
    /** Last time the seller (store owner) read this conversation; null = never. */
    sellerLastReadAt: timestamp("seller_last_read_at", { withTimezone: true }),
    /** Denormalised for cheap inbox sort/pagination; kept in sync on every `messages.send`. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One conversation per (buyer, store) pair — `conversations.start` upserts on this.
    uniqueIndex("conversations_buyer_id_store_id_key").on(t.buyerId, t.storeId),
    index("conversations_last_message_at_idx").on(t.lastMessageAt.desc()),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    senderUserId: uuid("sender_user_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Keyset pagination within a conversation: ORDER BY created_at DESC, id DESC.
    index("messages_conversation_id_created_at_id_idx").on(
      t.conversationId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    // chat.send rate limiting: COUNT(*) of a sender's recent messages across
    // ALL conversations (the pagination index above leads with conversation_id,
    // so it can't serve a sender-only lookup).
    index("messages_sender_user_id_created_at_idx").on(t.senderUserId, t.createdAt.desc()),
  ],
);

/**
 * Directional user-to-user block. `blocker_user_id` no longer wants to receive
 * messages from (or send to) `blocked_user_id`. Enforcement checks both
 * directions so either party blocking the other silences the conversation.
 */
export const userBlocks = pgTable(
  "user_blocks",
  {
    blockerUserId: uuid("blocker_user_id")
      .notNull()
      .references(() => users.id),
    blockedUserId: uuid("blocked_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.blockerUserId, t.blockedUserId] })],
);

export const messageReports = pgTable("message_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id")
    .notNull()
    .references(() => messages.id),
  reporterUserId: uuid("reporter_user_id")
    .notNull()
    .references(() => users.id),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Expo push tokens. Primary key is the token itself — `push.registerToken`
 * upserts by token, so re-registering a token on a new account (device changed
 * accounts) moves ownership to the new user rather than erroring.
 */
export const pushTokens = pgTable(
  "push_tokens",
  {
    token: text("token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    platform: text("platform").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("push_tokens_user_id_idx").on(t.userId)],
);
