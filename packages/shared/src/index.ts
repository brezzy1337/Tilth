/**
 * @homegrown/shared — single source of truth for every contract shared between
 * apps/server and apps/mobile. Both apps import zod schemas, inferred types, and
 * enums from this package; they never duplicate a shape locally.
 *
 * Note: `AppRouter` intentionally lives in `apps/server` (where tRPC routers
 * compose). Mobile imports it type-only from there to avoid a circular dependency.
 * This package holds everything else the two apps agree on.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Health-check response
// Returned by the server's health endpoint; rendered by mobile's status screen.
// ---------------------------------------------------------------------------

export const healthResponse = z.object({
  /** Always "ok" — any non-200 HTTP status means the server is not healthy. */
  status: z.literal("ok"),
  /** Human-readable service name, e.g. "homegrown-api". */
  service: z.string(),
  /** Seconds the process has been running; never negative. */
  uptimeSeconds: z.number().nonnegative(),
  /** ISO 8601 timestamp of when this response was generated. */
  timestamp: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponse>;

// ---------------------------------------------------------------------------
// Auth — register, login, session principal, and auth response
// Shared between the server router (validation) and mobile screens (forms).
// IMPORTANT: SessionUser intentionally omits password/hash — it is the safe
// public principal returned in tokens and stored in client state.
// ---------------------------------------------------------------------------

/** Input to `auth.register`. Username restricted to letters, digits, underscore. */
export const registerInput = z.object({
  email: z.string().email(),
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, "Username may only contain letters, digits, and underscores"),
  password: z.string().min(8).max(100),
});

export type RegisterInput = z.infer<typeof registerInput>;

/** Input to `auth.login`. Accepts either a username or an email as the first field. */
export const loginInput = z.object({
  usernameOrEmail: z.string().min(1),
  password: z.string().min(1),
});

export type LoginInput = z.infer<typeof loginInput>;

/**
 * Safe public principal — the subset of user fields that may leave the server.
 * Never includes a password, password hash, or any other credential.
 */
export const sessionUser = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  username: z.string(),
});

export type SessionUser = z.infer<typeof sessionUser>;

/**
 * Response returned by `auth.register` and `auth.login`.
 * `token` is a Bearer token the mobile app persists in Expo SecureStore and
 * sends as an `Authorization` header on subsequent requests.
 */
export const authResponse = z.object({
  token: z.string(),
  user: sessionUser,
});

export type AuthResponse = z.infer<typeof authResponse>;

// ---------------------------------------------------------------------------
// Trust tier — seller reliability badge (F-016)
// Computed from TERMINAL order history only (fulfilled + cancelled + refunded);
// pending_payment and paid orders are excluded (abandoned or still in-flight).
// Defined ahead of `storeProfile` below, which surfaces it on the public profile.
// ---------------------------------------------------------------------------

/**
 * Seller reliability badge earned from historical order fulfillment.
 * Gold > Silver > Bronze; a store may also have no badge (see `computeTrustTier`).
 */
export const trustTier = z.enum(["bronze", "silver", "gold"]);

export type TrustTier = z.infer<typeof trustTier>;

/**
 * Single source of truth for trust-tier thresholds, ordered highest tier first so
 * `computeTrustTier` can return the first match. A seller earns a tier only when
 * BOTH its fulfillment rate and terminal order volume meet or exceed the minimums.
 */
export const TRUST_TIER_THRESHOLDS = [
  { tier: "gold", minRate: 0.97, minOrders: 30 },
  { tier: "silver", minRate: 0.92, minOrders: 15 },
  { tier: "bronze", minRate: 0.85, minOrders: 5 },
] as const satisfies readonly { tier: TrustTier; minRate: number; minOrders: number }[];

/**
 * Pure function (no I/O) computing a seller's trust tier from terminal order counts.
 * `terminal = fulfilled + cancelled + refunded` (pending_payment/paid excluded).
 * Returns null when there is no terminal history, or when no threshold is met
 * (including terminal < 5, the minimum for the lowest tier, bronze).
 */
export function computeTrustTier(counts: {
  fulfilled: number;
  cancelled: number;
  refunded: number;
}): TrustTier | null {
  const terminal = counts.fulfilled + counts.cancelled + counts.refunded;
  if (terminal === 0) return null;

  const rate = counts.fulfilled / terminal;
  for (const threshold of TRUST_TIER_THRESHOLDS) {
    if (rate >= threshold.minRate && terminal >= threshold.minOrders) {
      return threshold.tier;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stores — create, get, and public store profile
// Matches the `stores` entity in §2.1: one store per user for the pilot.
// ---------------------------------------------------------------------------

/** Input to `stores.create` (protected). Server infers `userId` from the session. */
export const createStoreInput = z.object({
  name: z.string().min(1).max(120),
  logo: z.string().url().nullish(),
  about: z.string().max(2000).nullish(),
});

export type CreateStoreInput = z.infer<typeof createStoreInput>;

/** Input to `stores.get` (public). Returns the public store profile. */
export const getStoreInput = z.object({
  storeId: z.string().uuid(),
});

export type GetStoreInput = z.infer<typeof getStoreInput>;

/**
 * Full store record — the OWNER-FACING shape returned by `stores.create` and
 * `stores.getMine`. Includes `userId` + `stripeConnectAccountId` (so the owner's
 * client can detect Connect onboarding state). NOT public: the public
 * `stores.get` returns `storeProfile` (below), which omits those internal fields.
 */
export const store = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string(),
  logo: z.string().nullable(),
  about: z.string().nullable(),
  stripeConnectAccountId: z.string().nullable(),
});

export type Store = z.infer<typeof store>;

/**
 * Public store profile — safe subset returned by `stores.get` (no userId / Stripe ids).
 * `trustTier` is the seller's computed reliability badge (see `computeTrustTier` below);
 * null when the store has too little terminal order history to earn a badge.
 */
export const storeProfile = z.object({
  id: z.string().uuid(),
  name: z.string(),
  logo: z.string().nullable(),
  about: z.string().nullable(),
  trustTier: trustTier.nullable(),
});

export type StoreProfile = z.infer<typeof storeProfile>;

// ---------------------------------------------------------------------------
// Listings — enums, CRUD inputs, and output shape
// Consolidates the legacy PostedVegetables / PostedFruit / PostedHerbs triplet
// into one table driven by `listingCategory`. Money is always integer cents.
// ---------------------------------------------------------------------------

/** The category of a produce listing. Drives filtering in `listings.nearby`. */
export const listingCategory = z.enum(["vegetable", "fruit", "herb", "egg", "honey", "other"]);

export type ListingCategory = z.infer<typeof listingCategory>;

/** The sell-by unit for a listing quantity (e.g. "lb", "bunch"). */
export const listingUnit = z.enum(["each", "lb", "oz", "bunch", "dozen", "jar", "pint", "quart"]);

export type ListingUnit = z.infer<typeof listingUnit>;

/**
 * Input to `listings.create` (protected).
 * `storeId` is intentionally absent — the server infers it from the caller's session.
 */
export const createListingInput = z.object({
  name: z.string().min(1).max(120),
  category: listingCategory,
  /** Sale price in integer cents. Never a float. */
  priceCents: z.number().int().positive(),
  /** Available quantity. Zero means sold out; still visible. */
  quantity: z.number().int().nonnegative(),
  unit: listingUnit,
  /** Category-specific extras, e.g. `{ dried: true }` for herbs. */
  attributes: z.record(z.string(), z.unknown()).nullish(),
});

export type CreateListingInput = z.infer<typeof createListingInput>;

/**
 * Input to `listings.update` (protected, caller must own the store).
 * All editable fields are optional — only supply the fields that change.
 */
export const updateListingInput = z.object({
  listingId: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  category: listingCategory.optional(),
  /** Updated price in integer cents. Never a float. */
  priceCents: z.number().int().positive().optional(),
  quantity: z.number().int().nonnegative().optional(),
  unit: listingUnit.optional(),
  attributes: z.record(z.string(), z.unknown()).nullish(),
});

export type UpdateListingInput = z.infer<typeof updateListingInput>;

/** Input to `listings.listByStore` (public). Returns all listings for a store. */
export const listByStoreInput = z.object({
  storeId: z.string().uuid(),
});

export type ListByStoreInput = z.infer<typeof listByStoreInput>;

/**
 * Public listing output returned by `listings.listByStore` and related procedures.
 * `priceCents` is always an integer; never a float.
 */
export const listing = z.object({
  id: z.string().uuid(),
  storeId: z.string().uuid(),
  name: z.string(),
  category: listingCategory,
  /** Price in integer cents. */
  priceCents: z.number().int(),
  quantity: z.number().int(),
  unit: listingUnit,
  /** Nullable JSONB extras (e.g. `{ dried: true }`). */
  attributes: z.record(z.string(), z.unknown()).nullable(),
  /** ISO 8601 timestamp. */
  createdAt: z.string(),
  /** ISO 8601 timestamp. */
  updatedAt: z.string(),
});

export type Listing = z.infer<typeof listing>;

// ---------------------------------------------------------------------------
// Locations — typed address input + geocoded output
// Address → PostGIS point conversion happens server-side in `geo.setStoreLocation`.
// Clients never receive the raw `geography` column; they receive `lat`/`lng` floats.
// ---------------------------------------------------------------------------

/**
 * Input to `geo.setStoreLocation` (protected, caller's store).
 * The server geocodes the address to a PostGIS geography point — no geocoder
 * details belong in this contract.
 */
export const setStoreLocationInput = z.object({
  address: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(50),
  /** Text, not integer — ZIP codes can have leading zeros. */
  zip: z.string().min(3).max(12),
});

export type SetStoreLocationInput = z.infer<typeof setStoreLocationInput>;

/**
 * Store location output returned after geocoding.
 * `lat`/`lng` are the client-visible coordinates derived from the PostGIS point —
 * the raw `geography` column is never surfaced.
 */
export const location = z.object({
  id: z.string().uuid(),
  storeId: z.string().uuid(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  lat: z.number(),
  lng: z.number(),
});

export type Location = z.infer<typeof location>;

// ---------------------------------------------------------------------------
// Nearby — marketplace browse (§5 Geo)
// Mobile supplies device GPS; server runs ST_DWithin + ST_Distance, caps at 50.
// ---------------------------------------------------------------------------

/**
 * Input to `listings.nearby` (public).
 * `lat`/`lng` come from `expo-location` on the device — no address entry needed to browse.
 * `radiusKm` is capped at 200 km to prevent unbounded PostGIS scans.
 */
export const nearbyInput = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Search radius in kilometres. Maximum 200. */
  radiusKm: z.number().positive().max(200),
  /** Optional category filter applied before the PostGIS distance query. */
  category: listingCategory.optional(),
  /** Optional case-insensitive substring match on listing name. */
  query: z.string().trim().min(1).max(100).optional(),
});

export type NearbyInput = z.infer<typeof nearbyInput>;

/**
 * A single row returned by `listings.nearby`.
 * Combines listing fields, store identity, and computed distance/location so the
 * mobile browse screen can render pins and cards without a second round-trip.
 */
export const nearbyListing = z.object({
  id: z.string().uuid(),
  name: z.string(),
  category: listingCategory,
  /** Price in integer cents. */
  priceCents: z.number().int(),
  quantity: z.number().int(),
  unit: listingUnit,
  storeId: z.string().uuid(),
  storeName: z.string(),
  /** Computed by ST_Distance on the server; kilometres. */
  distanceKm: z.number(),
  /** Latitude of the store's PostGIS point. */
  lat: z.number(),
  /** Longitude of the store's PostGIS point. */
  lng: z.number(),
});

export type NearbyListing = z.infer<typeof nearbyListing>;

// ---------------------------------------------------------------------------
// Orders — M4 Payments backbone
// Money is always integer cents; never floats.
// ---------------------------------------------------------------------------

/**
 * Order status progression.
 * pending_payment → paid (via webhook) → fulfilled → cancelled / refunded / disputed.
 * disputed is set when a buyer files a chargeback (charge.dispute.created webhook).
 */
export const orderStatus = z.enum([
  "pending_payment",
  "paid",
  "fulfilled",
  "cancelled",
  "refunded",
  "disputed",
]);

export type OrderStatus = z.infer<typeof orderStatus>;

/** How the buyer receives the order. */
export const fulfillmentMethod = z.enum(["pickup", "delivery"]);
export type FulfillmentMethod = z.infer<typeof fulfillmentMethod>;

/**
 * Operational sub-state of a `paid` order, tracking seller prep progress.
 * Orthogonal to `orderStatus` — moves no money. Progresses packing → ready while
 * the order sits at `paid`; `orders.markFulfilled` (capture) is the step after
 * `ready`, marking pickup/hand-off. Null on the order DTO means not yet started
 * (freshly paid, prep not begun).
 */
export const orderPreparationState = z.enum(["packing", "ready"]);

export type OrderPreparationState = z.infer<typeof orderPreparationState>;

/** One line item within an order (input). */
export const orderItem = z.object({
  listingId: z.string().uuid(),
  /** Capped at 1 000 to bound the maximum `priceCents × quantity` product flowing into Stripe. */
  quantity: z.number().int().positive().max(1000),
});

export type OrderItem = z.infer<typeof orderItem>;

/**
 * Input to `orders.create` (protected).
 * Per-order caps: at most 50 line items, each with at most 1 000 units, to prevent
 * integer overflow of `priceCents × quantity` from reaching `application_fee_amount`.
 */
export const createOrderInput = z
  .object({
    items: z.array(orderItem).min(1).max(50),
    fulfillmentMethod,
    deliveryAddress: z.string().trim().min(1).max(300).optional(),
    tipCents: z.number().int().nonnegative().max(100000).optional(),
  })
  .refine(
    (v) => v.fulfillmentMethod !== "delivery" || (v.deliveryAddress?.length ?? 0) > 0,
    { path: ["deliveryAddress"], message: "Delivery address is required for delivery" },
  );

export type CreateOrderInput = z.infer<typeof createOrderInput>;

/** Input to `orders.requestRefund` (protected, caller must be the buyer). */
export const requestRefundInput = z.object({
  orderId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

export type RequestRefundInput = z.infer<typeof requestRefundInput>;

/** Input to `orders.approveRefund` (protected, caller must own the store). */
export const approveRefundInput = z.object({
  orderId: z.string().uuid(),
});

export type ApproveRefundInput = z.infer<typeof approveRefundInput>;

/** Input to `orders.declineRefund` (protected, caller must own the store). */
export const declineRefundInput = z.object({
  orderId: z.string().uuid(),
});

export type DeclineRefundInput = z.infer<typeof declineRefundInput>;

/** Input to `orders.markFulfilled` (protected, caller must own the store). */
export const markFulfilledInput = z.object({ orderId: z.string().uuid() });

export type MarkFulfilledInput = z.infer<typeof markFulfilledInput>;

/** Input to `orders.setPreparationState` (protected, caller must own the store). */
export const setPreparationStateInput = z.object({
  orderId: z.string().uuid(),
  state: orderPreparationState,
});

export type SetPreparationStateInput = z.infer<typeof setPreparationStateInput>;

/** Input to `orders.listForMyStore` (protected, caller must own the store). */
export const listForMyStoreInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(50).default(20),
});

export type ListForMyStoreInput = z.infer<typeof listForMyStoreInput>;

/** A fulfilled order item returned by `orders.get` / `orders.listMine`. */
export const orderItemOutput = z.object({
  id: z.string().uuid(),
  listingId: z.string().uuid(),
  nameSnapshot: z.string(),
  unitPriceCents: z.number().int(),
  quantity: z.number().int(),
  lineTotalCents: z.number().int(),
});

export type OrderItemOutput = z.infer<typeof orderItemOutput>;

/** Full order record returned by `orders.get` / `orders.listMine`. */
export const order = z.object({
  id: z.string().uuid(),
  storeId: z.string().uuid(),
  buyerId: z.string().uuid(),
  status: orderStatus,
  /** Operational prep progress while `status` is `paid`; null before prep starts. */
  preparationState: orderPreparationState.nullable(),
  subtotalCents: z.number().int(),
  applicationFeeCents: z.number().int(),
  totalCents: z.number().int(),
  tipCents: z.number().int(),
  stripePaymentIntentId: z.string().nullable(),
  fulfillmentMethod,
  deliveryAddress: z.string().nullable(),
  /** ISO 8601 datetime or null — set when the buyer submits a refund request. */
  refundRequestedAt: z.string().datetime().nullable(),
  /** Free-text reason supplied by the buyer at request time, or null. */
  refundReason: z.string().nullable(),
  /** ISO 8601 datetime or null — set when the seller approves the refund. */
  refundApprovedAt: z.string().datetime().nullable(),
  /** ISO 8601 datetime or null — set when the seller declines the refund request. */
  refundDeclinedAt: z.string().datetime().nullable(),
  items: z.array(orderItemOutput),
  /** ISO 8601 datetime string. */
  createdAt: z.string().datetime(),
  /** ISO 8601 datetime string. */
  updatedAt: z.string().datetime(),
});

export type Order = z.infer<typeof order>;

/**
 * Paginated response from `orders.listForMyStore`.
 * `nextCursor` is null when the caller has reached the last page.
 */
export const listForMyStoreOutput = z.object({
  orders: z.array(order),
  nextCursor: z.string().nullable(),
});

export type ListForMyStoreOutput = z.infer<typeof listForMyStoreOutput>;

/**
 * Response from `orders.create`.
 * `clientSecret` is the Stripe PaymentIntent client_secret for the PaymentSheet.
 */
export const createOrderResponse = z.object({
  order,
  clientSecret: z.string(),
});

export type CreateOrderResponse = z.infer<typeof createOrderResponse>;

// ---------------------------------------------------------------------------
// Stripe Connect — seller onboarding
// ---------------------------------------------------------------------------

/**
 * Input to `connect.createOnboardingLink` (protected).
 * No client-supplied URLs — the seller's return/refresh URLs are now configured server-side
 * from environment variables. Accepting these from the client was an open-redirect vulnerability:
 * any authenticated caller could direct Stripe to redirect to an arbitrary https URL.
 */
export const connectOnboardingInput = z.object({});

export type ConnectOnboardingInput = z.infer<typeof connectOnboardingInput>;

/** Response from `connect.createOnboardingLink`. */
export const connectOnboardingResponse = z.object({
  url: z.string().url(),
  accountId: z.string(),
});

export type ConnectOnboardingResponse = z.infer<typeof connectOnboardingResponse>;

/** Response from `connect.status`. */
export const connectStatus = z.object({
  connected: z.boolean(),
  chargesEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  detailsSubmitted: z.boolean(),
});

export type ConnectStatus = z.infer<typeof connectStatus>;

/** Response from `connect.dashboardLink` — a one-time Stripe Express Dashboard URL. */
export const connectDashboardLinkResponse = z.object({ url: z.string().url() });
export type ConnectDashboardLinkResponse = z.infer<typeof connectDashboardLinkResponse>;

// ---------------------------------------------------------------------------
// Garden posts / stories feed (F-047)
// Growers post photo sets or short (<=60s) videos of their gardens/produce;
// buyers scroll a vertical, geo-scoped feed (mirrors `listings.nearby`).
// Video is hosted on Mux: the server creates a direct upload, the mobile app
// PUTs the file to `uploadUrl`, and a `video.asset.ready` webhook flips the
// post's status from "processing" to "ready". Photo sets are born "ready" —
// there is no async encoding step. Photos are hosted on GCS + CDN.
// ---------------------------------------------------------------------------

/** The kind of garden post — a static photo set or a short video. */
export const gardenPostType = z.enum(["photo_set", "video"]);

export type GardenPostType = z.infer<typeof gardenPostType>;

/**
 * Lifecycle status of a garden post.
 * Photo sets are created directly as "ready" (no encoding step). Videos start
 * "processing" and flip to "ready" only when the server's Mux webhook handler
 * receives `video.asset.ready`.
 */
export const gardenPostStatus = z.enum(["processing", "ready"]);

export type GardenPostStatus = z.infer<typeof gardenPostStatus>;

/** A single photo within a garden post's photo set. */
export const gardenPostPhoto = z.object({
  url: z.string().url(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export type GardenPostPhoto = z.infer<typeof gardenPostPhoto>;

/**
 * Input to `gardenPosts.createPhotoSet` (protected).
 * `storeId` is intentionally absent — the server infers it from the authed
 * seller's session, matching `createListingInput` / `createStoreInput`.
 */
export const createGardenPostPhotoSetInput = z.object({
  /** Empty string allowed — captions are optional but the field itself is required. */
  caption: z.string().trim().max(500),
  photos: z.array(gardenPostPhoto).min(1).max(10),
});

export type CreateGardenPostPhotoSetInput = z.infer<typeof createGardenPostPhotoSetInput>;

/**
 * Input to `gardenPosts.createVideo` (protected).
 * `storeId` is inferred server-side, same as the photo-set input above.
 * `durationS` is client-reported (from the device's video picker) and is
 * advisory only — the server does not trust it for billing/limits.
 */
export const createGardenPostVideoInput = z.object({
  caption: z.string().trim().max(500),
  /** Seconds; capped at 60 to match the feature's short-video constraint. */
  durationS: z.number().positive().max(60).optional(),
});

export type CreateGardenPostVideoInput = z.infer<typeof createGardenPostVideoInput>;

/**
 * Response from `gardenPosts.createVideo`.
 * `uploadUrl` is the Mux direct-upload URL; the mobile app PUTs the raw video
 * file to it directly (the file itself never transits the HomeGrown server).
 * The post is created immediately in "processing" status at `postId`, and
 * flips to "ready" once the server's `video.asset.ready` webhook fires.
 */
export const createGardenPostVideoOutput = z.object({
  postId: z.string().uuid(),
  uploadUrl: z.string().url(),
});

export type CreateGardenPostVideoOutput = z.infer<typeof createGardenPostVideoOutput>;

/**
 * Input to `gardenPosts.feed` (public).
 * Mirrors `nearbyInput`'s geo bounds; `radiusKm` defaults to 25 (tighter than
 * `listings.nearby`'s no-default since the feed is meant to feel local) and
 * is capped at 100 km. Cursor-paginated like `orders.listForMyStore`.
 */
export const gardenFeedInput = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Search radius in kilometres. Defaults to 25; capped at 100. */
  radiusKm: z.number().positive().max(100).default(25),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export type GardenFeedInput = z.infer<typeof gardenFeedInput>;

/** Fields common to every `gardenFeedItem` variant, regardless of post type. */
const gardenFeedItemBase = z.object({
  id: z.string().uuid(),
  storeId: z.string().uuid(),
  storeName: z.string(),
  /** Computed by ST_Distance on the server; kilometres. */
  distanceKm: z.number(),
  caption: z.string(),
  status: gardenPostStatus,
  /** ISO 8601 datetime string. */
  createdAt: z.string().datetime(),
});

/** A photo-set garden post as rendered in the feed. */
export const gardenFeedPhotoSetItem = gardenFeedItemBase.extend({
  type: z.literal("photo_set"),
  photos: z.array(gardenPostPhoto),
});

export type GardenFeedPhotoSetItem = z.infer<typeof gardenFeedPhotoSetItem>;

/** A video garden post as rendered in the feed; `posterUrl` comes from image.mux.com. */
export const gardenFeedVideoItem = gardenFeedItemBase.extend({
  type: z.literal("video"),
  muxPlaybackId: z.string(),
  posterUrl: z.string().url(),
  durationS: z.number().positive().optional(),
});

export type GardenFeedVideoItem = z.infer<typeof gardenFeedVideoItem>;

/**
 * A single row returned by `gardenPosts.feed`, discriminated on `type` so
 * mobile can render photo-set cards vs. video players without runtime checks.
 */
export const gardenFeedItem = z.discriminatedUnion("type", [
  gardenFeedPhotoSetItem,
  gardenFeedVideoItem,
]);

export type GardenFeedItem = z.infer<typeof gardenFeedItem>;

/**
 * Paginated response from `gardenPosts.feed`.
 * `nextCursor` is null when the caller has reached the last page, matching
 * `listForMyStoreOutput`'s pagination convention.
 */
export const gardenFeedOutput = z.object({
  items: z.array(gardenFeedItem),
  nextCursor: z.string().nullable(),
});

export type GardenFeedOutput = z.infer<typeof gardenFeedOutput>;

// ---------------------------------------------------------------------------
// Messaging — 1:1 buyer<->store conversations (F-037/F-038)
// One conversation per (buyerId, storeId) pair. Buyers start a conversation;
// sellers may only reply within one that already exists. Text-only for the
// MVP. Includes reporting/blocking for App Store Guideline 1.2 (UGC
// moderation) and Expo push-token registration for message notifications.
// ---------------------------------------------------------------------------

/** A message's text content. Trimmed; 1-2000 characters. */
export const messageBody = z.string().trim().min(1).max(2000);

export type MessageBody = z.infer<typeof messageBody>;

/** A single chat message, as returned by `messages.list` / sent via `messages.send`. */
export const chatMessage = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  senderUserId: z.string().uuid(),
  body: messageBody,
  /** ISO 8601 datetime string. */
  createdAt: z.string().datetime(),
});

export type ChatMessage = z.infer<typeof chatMessage>;

/**
 * Inbox row returned by `conversations.list`. Includes both parties' display
 * names since the client (buyer or seller) determines which side is "self"
 * from its own auth context — the server doesn't assume a viewpoint.
 */
export const conversationSummary = z.object({
  id: z.string().uuid(),
  storeId: z.string().uuid(),
  storeName: z.string(),
  buyerId: z.string().uuid(),
  buyerName: z.string(),
  /** Preview text of the most recent message; null if the conversation has none. */
  lastMessageBody: z.string().nullable(),
  /** ISO 8601 datetime of the most recent message; null if the conversation has none. */
  lastMessageAt: z.string().datetime().nullable(),
  /** Count of messages unread by the caller. */
  unreadCount: z.number().int().nonnegative(),
});

export type ConversationSummary = z.infer<typeof conversationSummary>;

/**
 * Paginated response from `conversations.list`, most-recent-activity first.
 * `nextCursor` is null when the caller has reached the last page, matching
 * `listForMyStoreOutput` / `gardenFeedOutput`'s pagination convention.
 */
export const conversationsListOutput = z.object({
  items: z.array(conversationSummary),
  nextCursor: z.string().nullable(),
});

export type ConversationsListOutput = z.infer<typeof conversationsListOutput>;

/**
 * Input to `conversations.start` (protected, buyer-initiated).
 * A buyer opens a conversation with a store; sellers reply within conversations
 * that already exist rather than starting new ones. Idempotent per
 * (buyerId, storeId) pair — the server returns the existing conversation if one
 * is already open.
 */
export const startConversationInput = z.object({
  storeId: z.string().uuid(),
});

export type StartConversationInput = z.infer<typeof startConversationInput>;

/** Response from `conversations.start`. */
export const startConversationOutput = z.object({
  conversationId: z.string().uuid(),
});

export type StartConversationOutput = z.infer<typeof startConversationOutput>;

/**
 * Input to `messages.list` (protected, caller must be a participant).
 * Cursor-paginated, newest-first pages (mirrors chat-app convention: most
 * recent messages load first, older ones page in on scroll-up).
 */
export const messagesListInput = z.object({
  conversationId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

export type MessagesListInput = z.infer<typeof messagesListInput>;

/**
 * Paginated response from `messages.list`, newest-first.
 * `nextCursor` is null when the caller has reached the last (oldest) page.
 */
export const messagesListOutput = z.object({
  items: z.array(chatMessage),
  nextCursor: z.string().nullable(),
});

export type MessagesListOutput = z.infer<typeof messagesListOutput>;

/** Input to `messages.send` (protected, caller must be a participant). */
export const sendMessageInput = z.object({
  conversationId: z.string().uuid(),
  body: messageBody,
});

export type SendMessageInput = z.infer<typeof sendMessageInput>;

/** Input to `conversations.markRead` (protected, caller must be a participant). */
export const markConversationReadInput = z.object({
  conversationId: z.string().uuid(),
});

export type MarkConversationReadInput = z.infer<typeof markConversationReadInput>;

/**
 * Input to `moderation.blockUser` (protected).
 * Blocking a user prevents further messages between the caller and `userId`;
 * enforcement happens server-side.
 */
export const blockUserInput = z.object({
  userId: z.string().uuid(),
});

export type BlockUserInput = z.infer<typeof blockUserInput>;

/**
 * Input to `moderation.reportMessage` (protected).
 * Satisfies App Store Guideline 1.2 (apps with user-generated content must
 * offer a mechanism to report objectionable content).
 */
export const reportMessageInput = z.object({
  messageId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
});

export type ReportMessageInput = z.infer<typeof reportMessageInput>;

/** Input to `push.registerToken` (protected). Registers an Expo push token for the device. */
export const registerPushTokenInput = z.object({
  token: z.string().min(1).max(200),
  platform: z.enum(["ios", "android"]),
});

export type RegisterPushTokenInput = z.infer<typeof registerPushTokenInput>;
