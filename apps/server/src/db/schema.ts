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
  date,
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
  /**
   * F-051 — soft-delete: set (alongside `deleteAfter`) by `auth.deleteAccount`;
   * null = active account. A password-verified `auth.login` inside the grace
   * window (`deleteAfter` still in the future) clears both fields, self-
   * restoring the account. Once set, this hides the user's selling surfaces
   * from public discovery (see `helpers.ts`'s `activeUserClause`/`isUserDeactivated`)
   * but does NOT invalidate already-issued JWTs — auth is stateless (see
   * `trpc.ts`'s `protectedProcedure` doc comment).
   */
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  /** F-051 — the 30-day grace deadline; the operator purge CLI anonymizes
   *  (never row-deletes) accounts past this timestamp. Null = active account. */
  deleteAfter: timestamp("delete_after", { withTimezone: true }),
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
    /**
     * F-049 — set only on the ORIGINATING message of a sourcing request/offer
     * (the message that carries the request "card"); null for ordinary
     * messages AND for the accept/decline/withdraw follow-up messages
     * (those stay plain text — one card per request). References
     * `sourcingRequests`, declared further down this file; the callback form
     * defers resolution past declaration order.
     */
    sourcingRequestId: uuid("sourcing_request_id").references(() => sourcingRequests.id),
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

// ---------------------------------------------------------------------------
// Community places — F-048 Home map pins (co-ops, health-food stores,
// farmers markets) imported from OpenStreetMap + the USDA farmers-market
// directory into PostGIS. Imports land as 'pending'; only 'approved' rows
// are served by `places.nearby`. `type`/`source`/`status` are plain text
// (not pgEnum) — validated against the shared `communityPlaceType` zod enum
// at the tRPC boundary and written only by the vetted import CLI, so a DB
// enum isn't load-bearing here the way it is for listings.
// ---------------------------------------------------------------------------

export const communityPlaces = pgTable(
  "community_places",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'farmers_market' | 'coop' | 'health_food' — mirrors shared `communityPlaceType`. */
    type: text("type").notNull(),
    name: text("name").notNull(),
    /** PostGIS geography(Point,4326) — never parsed JS-side; use ST_X/ST_Y. */
    location: geography("location").notNull(),
    address: text("address"),
    website: text("website"),
    hoursText: text("hours_text"),
    /** 'osm' | 'usda' | 'manual' — where this row was imported from. */
    source: text("source").notNull(),
    /** OSM element id (e.g. "way/39448667"), USDA listing id, or a manual slug. */
    sourceRef: text("source_ref").notNull(),
    /** 'pending' | 'approved' | 'rejected'. Only 'approved' rows are served. */
    status: text("status").notNull().default("pending"),
    /**
     * F-049 — the operator-invited user account (see
     * `scripts/link-place-buyer.ts`) authorized to act as this place's buyer
     * for sourcing requests/offers. Nullable — most places have no linked
     * account. Unique — one place per user account. Set/cleared only by the
     * operator CLI, never by a tRPC procedure.
     */
    linkedUserId: uuid("linked_user_id").references(() => users.id).unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("community_places_location_idx").using("gist", t.location),
    // Idempotent re-imports: same (source, source_ref) upserts instead of duplicating.
    uniqueIndex("community_places_source_source_ref_key").on(t.source, t.sourceRef),
    index("community_places_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Sourcing requests — F-049 structured produce requests/offers between
// community places (co-ops/markets) and growers (stores). Rides the existing
// chat: the originating message carries `sourcingRequestId`; accept/decline/
// withdraw append plain-text follow-up messages (no id) so there is exactly
// one card per request. `direction`/`status` are plain text (not pgEnum) —
// same rationale as `communityPlaces.type`/`.status` above: validated against
// the shared `sourcingRequestDirection`/`sourcingRequestStatus` zod enums at
// the tRPC boundary.
// ---------------------------------------------------------------------------

export const sourcingRequests = pgTable(
  "sourcing_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'place_to_grower' | 'grower_to_place' — mirrors shared `sourcingRequestDirection`. */
    direction: text("direction").notNull(),
    placeId: uuid("place_id")
      .notNull()
      .references(() => communityPlaces.id),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    /** The conversation (see Messaging, above) this request rides on. */
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    produce: text("produce").notNull(),
    quantity: text("quantity").notNull(),
    /** Date-only (no time component); nullable — "needed by" is optional. */
    neededBy: date("needed_by", { mode: "string" }),
    note: text("note"),
    /** 'pending' | 'accepted' | 'declined' | 'withdrawn' — mirrors shared `sourcingRequestStatus`. */
    status: text("status").notNull().default("pending"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    /** Set when the counterparty accepts/declines; null while pending. */
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sourcing_requests_store_id_created_at_idx").on(t.storeId, t.createdAt.desc()),
    index("sourcing_requests_place_id_created_at_idx").on(t.placeId, t.createdAt.desc()),
    index("sourcing_requests_conversation_id_idx").on(t.conversationId),
  ],
);
