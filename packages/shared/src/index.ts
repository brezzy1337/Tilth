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

/**
 * The password constraint shared by every auth/account-settings input that
 * accepts a raw password (register, change-password, delete-account
 * confirmation). Defined once so all call sites parse identically — never
 * redeclare `z.string().min(8).max(100)` inline elsewhere.
 */
export const passwordSchema = z.string().min(8).max(100);

export type Password = z.infer<typeof passwordSchema>;

/** Input to `auth.register`. Username restricted to letters, digits, underscore. */
export const registerInput = z.object({
  email: z.string().email(),
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, "Username may only contain letters, digits, and underscores"),
  password: passwordSchema,
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
// Account settings (F-051) — change password, soft-delete account (30-day
// grace period), blocked-users management, push-token unregister.
// `passwordSchema` (above, in Auth) is reused here so password strength rules
// stay identical across registration, password change, and delete confirmation.
// ---------------------------------------------------------------------------

/** Input to `auth.changePassword` (protected). */
export const changePasswordInput = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

/**
 * Input to `auth.deleteAccount` (protected). Password re-confirmation guards
 * against a hijacked/unattended session triggering a destructive action.
 */
export const deleteAccountInput = z.object({
  password: passwordSchema,
});

export type DeleteAccountInput = z.infer<typeof deleteAccountInput>;

/**
 * Response from `auth.deleteAccount`. The account is soft-deleted with a
 * 30-day grace period; `deleteAfter` is the ISO 8601 datetime the server will
 * hard-delete the account, surfaced so the client can display a "you can
 * still undo this until ..." message.
 */
export const deleteAccountOutput = z.object({
  deleteAfter: z.string().datetime(),
});

export type DeleteAccountOutput = z.infer<typeof deleteAccountOutput>;

/**
 * A single blocked user, as returned by `chat.listBlocked`.
 * Mirrors `blockUserInput`'s `userId` (below, in Messaging) — moderation acts
 * on USER ids, not store ids.
 */
export const blockedUser = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  /** ISO 8601 datetime — when the caller blocked this user. */
  blockedAt: z.string().datetime(),
});

export type BlockedUser = z.infer<typeof blockedUser>;

/** Response from `chat.listBlocked` — capped at 200 blocked users. */
export const listBlockedOutput = z.array(blockedUser).max(200);

export type ListBlockedOutput = z.infer<typeof listBlockedOutput>;

/** Input to `chat.unblockUser` (protected). Inverse of `blockUserInput`. */
export const unblockUserInput = z.object({
  userId: z.string().uuid(),
});

export type UnblockUserInput = z.infer<typeof unblockUserInput>;

/**
 * Input to `chat.unregisterPushToken` (protected). Mirrors `registerPushTokenInput`
 * (below, in Messaging) but takes only the token — unregistering doesn't need
 * `platform`, since the server looks the row up by token value alone.
 */
export const unregisterPushTokenInput = z.object({
  token: z.string().min(1).max(200),
});

export type UnregisterPushTokenInput = z.infer<typeof unregisterPushTokenInput>;

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
 * `terminal = fulfilled + cancelled + refunded` (pending_payment/paid excluded) —
 * this must stay in sync with `TERMINAL_ORDER_STATUSES` (defined below, near
 * `orderStatus`); see that constant's doc comment for the full consumer list.
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

/**
 * Order statuses considered terminal — the order lifecycle is complete and no
 * further status transitions are valid. Single source of truth; consumed by:
 * - `apps/server/src/db/order-transitions.ts` (`TERMINAL_ORDER_STATUSES`, the
 *   transition-guard constant — keep both arrays in sync)
 * - `computeTrustTier` above (sums `fulfilled + cancelled + refunded` terminal counts)
 * - `stores.get` trust-tier aggregation (server query that builds the counts
 *   passed into `computeTrustTier`)
 */
export const TERMINAL_ORDER_STATUSES = [
  "fulfilled",
  "cancelled",
  "refunded",
] as const satisfies readonly OrderStatus[];

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
  .refine((v) => v.fulfillmentMethod !== "delivery" || (v.deliveryAddress?.length ?? 0) > 0, {
    path: ["deliveryAddress"],
    message: "Delivery address is required for delivery",
  });

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
 * Input to `garden.createPhotoSet` (protected).
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
 * Input to `garden.createVideo` (protected).
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
 * Response from `garden.createVideo`.
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
 * Input to `garden.feed` (public).
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

/**
 * Fields common to every `gardenFeedItem` variant, regardless of post type.
 * `likeCount`/`likedByMe`/`commentCount` are the F-053 social counts — see the
 * "Garden social (F-053)" section below for the schemas that mutate them
 * (`toggleGardenLikeInput`/Output, comment CRUD).
 */
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
  /** Total likes on this post. */
  likeCount: z.number().int().nonnegative(),
  /** Whether the requesting caller has liked this post. */
  likedByMe: z.boolean(),
  /** Total non-deleted comments on this post. */
  commentCount: z.number().int().nonnegative(),
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
 * A single row returned by `garden.feed`, discriminated on `type` so
 * mobile can render photo-set cards vs. video players without runtime checks.
 */
export const gardenFeedItem = z.discriminatedUnion("type", [
  gardenFeedPhotoSetItem,
  gardenFeedVideoItem,
]);

export type GardenFeedItem = z.infer<typeof gardenFeedItem>;

/**
 * Paginated response from `garden.feed`.
 * `nextCursor` is null when the caller has reached the last page, matching
 * `listForMyStoreOutput`'s pagination convention.
 */
export const gardenFeedOutput = z.object({
  items: z.array(gardenFeedItem),
  nextCursor: z.string().nullable(),
});

export type GardenFeedOutput = z.infer<typeof gardenFeedOutput>;

// ---------------------------------------------------------------------------
// Sourcing — structured produce requests between community places and growers
// (F-049). A "sourcing request" rides the existing chat (see Messaging,
// below) as a message with an attached request; the counterparty accepts,
// declines, or the creator withdraws it. Two directions are both first-class:
// a place buyer asking a grower to supply produce ("place_to_grower"), and a
// grower offering to supply a place ("grower_to_place"). User-facing copy may
// say "fulfillment request" — no code identifier here uses that word, since
// `fulfillmentMethod` / `markFulfilled` above already mean consumer-order
// pickup/delivery, a different concept.
// Declared ahead of Messaging so `chatMessage` (below) can attach a nullable
// `sourcingRequest` to a message.
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a sourcing request/offer.
 * pending → accepted / declined (by the counterparty) or withdrawn (by the
 * creator). Terminal once accepted, declined, or withdrawn — no further
 * transitions.
 */
export const sourcingRequestStatus = z.enum(["pending", "accepted", "declined", "withdrawn"]);

export type SourcingRequestStatus = z.infer<typeof sourcingRequestStatus>;

/**
 * Which party initiated the sourcing exchange.
 * `place_to_grower` — a community place (co-op/market) asks a grower to
 * supply produce (a "request"). `grower_to_place` — a grower offers to
 * supply a place (an "offer"). Both directions share the same underlying
 * shape; only the direction of the ask differs.
 */
export const sourcingRequestDirection = z.enum(["place_to_grower", "grower_to_place"]);

export type SourcingRequestDirection = z.infer<typeof sourcingRequestDirection>;

/**
 * Free-text produce description, e.g. "heirloom tomatoes". Not a
 * `listingCategory` — a B2B ask may span multiple listings or produce the
 * grower hasn't listed yet.
 */
export const sourcingProduce = z.string().trim().min(1).max(120);

export type SourcingProduce = z.infer<typeof sourcingProduce>;

/**
 * Free-text quantity, e.g. "20 lb" or "6 flats". Deliberately a string, not a
 * `listingUnit` + number pair — B2B asks don't fit the consumer listing unit
 * enum (e.g. "a few cases", "TBD, will confirm by weight").
 */
export const sourcingQuantity = z.string().trim().min(1).max(80);

export type SourcingQuantity = z.infer<typeof sourcingQuantity>;

/** Optional free-text note attached to a sourcing request/offer. */
export const sourcingNote = z.string().trim().max(500);

export type SourcingNote = z.infer<typeof sourcingNote>;

/** Input to `sourcing.createRequest` (protected, place buyer -> grower). */
export const createSourcingRequestInput = z.object({
  storeId: z.string().uuid(),
  produce: sourcingProduce,
  quantity: sourcingQuantity,
  /** ISO 8601 date (no time component), e.g. "2026-08-01". Optional. */
  neededBy: z.string().date().optional(),
  note: sourcingNote.optional(),
});

export type CreateSourcingRequestInput = z.infer<typeof createSourcingRequestInput>;

/** Input to `sourcing.createOffer` (protected, grower -> place). */
export const createSourcingOfferInput = z.object({
  placeId: z.string().uuid(),
  produce: sourcingProduce,
  quantity: sourcingQuantity,
  /** ISO 8601 date (no time component), e.g. "2026-08-01". Optional. */
  neededBy: z.string().date().optional(),
  note: sourcingNote.optional(),
});

export type CreateSourcingOfferInput = z.infer<typeof createSourcingOfferInput>;

/**
 * Input to `sourcing.respond` (protected, caller must be the counterparty,
 * i.e. NOT the creator of the request/offer).
 */
export const respondSourcingRequestInput = z.object({
  requestId: z.string().uuid(),
  response: z.enum(["accepted", "declined"]),
});

export type RespondSourcingRequestInput = z.infer<typeof respondSourcingRequestInput>;

/** Input to `sourcing.withdraw` (protected, caller must be the creator). */
export const withdrawSourcingRequestInput = z.object({
  requestId: z.string().uuid(),
});

export type WithdrawSourcingRequestInput = z.infer<typeof withdrawSourcingRequestInput>;

/**
 * A single sourcing request/offer, as returned by `sourcing.listMine` and
 * attached to the chat message that carries it (see `chatMessage.sourcingRequest`
 * below). `placeId`/`placeName` and `storeId`/`storeName` are always both
 * present regardless of `direction`, so the client doesn't need to branch on
 * direction to render either party's identity.
 */
export const sourcingRequest = z.object({
  id: z.string().uuid(),
  direction: sourcingRequestDirection,
  status: sourcingRequestStatus,
  placeId: z.string().uuid(),
  placeName: z.string(),
  storeId: z.string().uuid(),
  storeName: z.string(),
  /** The conversation (see Messaging, below) this request rides on. */
  conversationId: z.string().uuid(),
  produce: sourcingProduce,
  quantity: sourcingQuantity,
  /** ISO 8601 date (no time component), or null if not specified. */
  neededBy: z.string().date().nullable(),
  note: z.string().nullable(),
  createdByUserId: z.string().uuid(),
  /** ISO 8601 datetime — set when the counterparty accepts/declines; null while pending. */
  respondedAt: z.string().datetime().nullable(),
  /** ISO 8601 datetime string. */
  createdAt: z.string().datetime(),
});

export type SourcingRequest = z.infer<typeof sourcingRequest>;

/** Response from `sourcing.createRequest` and `sourcing.createOffer`. */
export const createSourcingRequestOutput = z.object({
  request: sourcingRequest,
  conversationId: z.string().uuid(),
});

export type CreateSourcingRequestOutput = z.infer<typeof createSourcingRequestOutput>;

/** Response from `sourcing.listMine` — capped at 50 requests/offers. */
export const sourcingListMineOutput = z.array(sourcingRequest).max(50);

export type SourcingListMineOutput = z.infer<typeof sourcingListMineOutput>;

/**
 * A single grower row returned by `sourcing.growers` — the browse list a
 * community place uses to pick who to request produce from. Takes
 * `nearbyInput` (above) as its input; no separate input schema is needed.
 */
export const sourcingGrowerSummary = z.object({
  storeId: z.string().uuid(),
  name: z.string(),
  logo: z.string().nullable(),
  /** Computed by ST_Distance on the server; kilometres. */
  distanceKm: z.number(),
  listingCount: z.number().int().nonnegative(),
  /** Up to 3 sample listing names, for a quick "grows: ..." preview. */
  sampleListings: z.array(z.string()).max(3),
});

export type SourcingGrowerSummary = z.infer<typeof sourcingGrowerSummary>;

/** Response from `sourcing.growers` — capped at 30 growers per request. */
export const sourcingGrowersOutput = z.array(sourcingGrowerSummary).max(30);

export type SourcingGrowersOutput = z.infer<typeof sourcingGrowersOutput>;

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

/**
 * A single chat message, as returned by `messages.list` / sent via `messages.send`.
 * `sourcingRequest` is non-null when this message carries a structured
 * produce request/offer (see the Sourcing section, above) — the counterparty
 * accepts/declines it from within the thread.
 */
export const chatMessage = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  senderUserId: z.string().uuid(),
  body: messageBody,
  sourcingRequest: sourcingRequest.nullable(),
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
  /**
   * The store owner's user id — symmetric with `buyerId`, so a buyer can
   * block/report the seller (moderation inputs take a USER id, not a store id).
   */
  storeUserId: z.string().uuid(),
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

/** Input to `conversations.list` (protected) — cursor-paginated inbox. */
export const conversationsListInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

export type ConversationsListInput = z.infer<typeof conversationsListInput>;

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
 * Input to `chat.blockUser` (protected).
 * Blocking a user prevents further messages between the caller and `userId`;
 * enforcement happens server-side.
 */
export const blockUserInput = z.object({
  userId: z.string().uuid(),
});

export type BlockUserInput = z.infer<typeof blockUserInput>;

/**
 * Shared "reason" validator for user-generated-content reports — trimmed,
 * 1-500 characters. Used by both `reportMessageInput` (chat) and
 * `reportGardenCommentInput` (garden social, F-053) so the two report flows
 * can't drift apart.
 */
export const reportReasonSchema = z.string().trim().min(1).max(500);

export type ReportReason = z.infer<typeof reportReasonSchema>;

/**
 * Input to `chat.reportMessage` (protected).
 * Satisfies App Store Guideline 1.2 (apps with user-generated content must
 * offer a mechanism to report objectionable content).
 */
export const reportMessageInput = z.object({
  messageId: z.string().uuid(),
  reason: reportReasonSchema,
});

export type ReportMessageInput = z.infer<typeof reportMessageInput>;

/** Input to `push.registerToken` (protected). Registers an Expo push token for the device. */
export const registerPushTokenInput = z.object({
  token: z.string().min(1).max(200),
  platform: z.enum(["ios", "android"]),
});

export type RegisterPushTokenInput = z.infer<typeof registerPushTokenInput>;

// ---------------------------------------------------------------------------
// Garden social — likes, comments, and per-post share links (F-053)
// A social layer on top of the F-047 garden feed (see the Garden posts
// section, above, which now carries `likeCount`/`likedByMe`/`commentCount` on
// every `gardenFeedItem`). Comments are flat (no replies/threads) and mirror
// the Messaging section's idioms: `gardenCommentBody` mirrors `messageBody`,
// `listGardenCommentsInput`/Output mirror `messagesListInput`/Output's
// cursor-pagination shape, and `reportGardenCommentInput` mirrors
// `reportMessageInput`. The share page itself has no dedicated schema here —
// it renders the same `gardenFeedItem`-shaped data the server already
// serves, just keyed by post id instead of a geo query.
// ---------------------------------------------------------------------------

/** Input to `garden.toggleLike` (protected). Toggles the caller's like on a post. */
export const toggleGardenLikeInput = z.object({
  postId: z.string().uuid(),
});

export type ToggleGardenLikeInput = z.infer<typeof toggleGardenLikeInput>;

/**
 * Response from `garden.toggleLike`.
 * `liked` is the caller's new like state after the toggle (not the previous
 * one); `likeCount` is the post's total count after the change, so the
 * client can update its UI from this response alone, without refetching.
 */
export const toggleGardenLikeOutput = z.object({
  liked: z.boolean(),
  likeCount: z.number().int().nonnegative(),
});

export type ToggleGardenLikeOutput = z.infer<typeof toggleGardenLikeOutput>;

/** A garden comment's text content. Trimmed; 1-500 characters — mirrors `messageBody`'s idiom, shorter cap. */
export const gardenCommentBody = z.string().trim().min(1).max(500);

export type GardenCommentBody = z.infer<typeof gardenCommentBody>;

/**
 * A single garden post comment, as returned by `garden.listComments` / created
 * via `garden.createComment`. `username` is denormalized onto the comment
 * (same pattern as `blockedUser.username`, above) so the feed/share page can
 * render "who said it" without a join per render. When `deleted` is true the
 * server sends `body` as `""` and the client renders a "[comment removed]"
 * placeholder — the row is soft-deleted, not hard-deleted, so moderation and
 * the author's own delete both resolve to the same client-visible shape.
 */
export const gardenComment = z.object({
  id: z.string().uuid(),
  postId: z.string().uuid(),
  userId: z.string().uuid(),
  username: z.string(),
  body: z.string(),
  /** ISO 8601 datetime string. */
  createdAt: z.string().datetime(),
  /** True when soft-deleted (by the author or moderation); `body` is then `""`. */
  deleted: z.boolean(),
});

export type GardenComment = z.infer<typeof gardenComment>;

/** Input to `garden.createComment` (protected, caller must be authenticated). */
export const createGardenCommentInput = z.object({
  postId: z.string().uuid(),
  body: gardenCommentBody,
});

export type CreateGardenCommentInput = z.infer<typeof createGardenCommentInput>;

/** Response from `garden.createComment` — the newly created comment. */
export const createGardenCommentOutput = gardenComment;

export type CreateGardenCommentOutput = z.infer<typeof createGardenCommentOutput>;

/**
 * Input to `garden.listComments` (public — comments are visible to anyone who
 * can see the post, including the public share page).
 * Cursor-paginated; limit default/max mirror `messagesListInput` exactly
 * (default 30, max 100).
 */
export const listGardenCommentsInput = z.object({
  postId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

export type ListGardenCommentsInput = z.infer<typeof listGardenCommentsInput>;

/**
 * Paginated response from `garden.listComments`.
 * Mirrors `messagesListOutput`'s shape exactly (an array field plus a
 * nullable `nextCursor`) — `nextCursor` is null when the caller has reached
 * the last page.
 */
export const listGardenCommentsOutput = z.object({
  comments: z.array(gardenComment),
  nextCursor: z.string().nullable(),
});

export type ListGardenCommentsOutput = z.infer<typeof listGardenCommentsOutput>;

/**
 * Input to `garden.deleteComment` (protected, caller must be the comment's
 * author — soft-delete only, matching `gardenComment.deleted`'s semantics).
 */
export const deleteGardenCommentInput = z.object({
  commentId: z.string().uuid(),
});

export type DeleteGardenCommentInput = z.infer<typeof deleteGardenCommentInput>;

/**
 * Input to `garden.reportComment` (protected).
 * Shares `reportReasonSchema` with `reportMessageInput` (trimmed, 1-500
 * characters) — same App Store Guideline 1.2 UGC-reporting rationale.
 */
export const reportGardenCommentInput = z.object({
  commentId: z.string().uuid(),
  reason: reportReasonSchema,
});

export type ReportGardenCommentInput = z.infer<typeof reportGardenCommentInput>;

// ---------------------------------------------------------------------------
// Community places — Home map pins (F-048)
// Co-ops, health-food stores, and farmers markets imported from OpenStreetMap
// + the USDA farmers-market directory into PostGIS. V1 tap behavior is an
// info card (name, type, address, directions); no in-app booking/orders.
// `placesNearby` mirrors `listings.nearby`'s geo-input shape and
// `gardenFeedInput`'s radius default/cap.
// ---------------------------------------------------------------------------

/** The kind of community place shown as a Home map pin. */
export const communityPlaceType = z.enum(["farmers_market", "coop", "health_food"]);

export type CommunityPlaceType = z.infer<typeof communityPlaceType>;

/**
 * A single community place returned by `places.nearby`.
 * `hoursText` is intentionally freeform display text (e.g. "Sat 8am–1pm,
 * May–Oct") rather than structured hours — source data (OSM + the USDA
 * farmers-market directory) is too inconsistent to normalize into a
 * structured schedule for V1.
 */
export const communityPlace = z.object({
  id: z.string().uuid(),
  type: communityPlaceType,
  name: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().max(300).nullable(),
  // `.url()` alone admits any scheme (`javascript:`, `data:`, …) — the mobile
  // app may render this as a tappable link, so pin it to http(s).
  website: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), { message: "website must be an http(s) URL" })
    .nullable(),
  /** Freeform display text, e.g. "Sat 8am–1pm, May–Oct". Not structured hours. */
  hoursText: z.string().max(500).nullable(),
  /** Computed by ST_Distance on the server; kilometres. */
  distanceKm: z.number().nonnegative(),
  /**
   * True when this place has a linked buyer account (an operator-invited
   * user tied via `community_places.linked_user_id`) that can receive
   * sourcing offers. Drives the mobile "Offer to supply" CTA — offering
   * produce to a place with no linked account would have no one to notify.
   */
  acceptsOffers: z.boolean(),
});

export type CommunityPlace = z.infer<typeof communityPlace>;

/**
 * Input to `places.nearby` (public).
 * Mirrors `nearbyInput`'s lat/lng bounds and `gardenFeedInput`'s radius
 * default (25 km) and cap (100 km). `type` optionally filters to a single
 * `communityPlaceType` before the PostGIS distance query.
 */
export const placesNearbyInput = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Search radius in kilometres. Defaults to 25; capped at 100. */
  radiusKm: z.number().positive().max(100).default(25),
  type: communityPlaceType.optional(),
});

export type PlacesNearbyInput = z.infer<typeof placesNearbyInput>;

/** Response from `places.nearby` — capped at 200 pins per request. */
export const placesNearbyOutput = z.array(communityPlace).max(200);

export type PlacesNearbyOutput = z.infer<typeof placesNearbyOutput>;

/**
 * Response from `places.mine` — the community place linked to the caller's
 * account via `community_places.linked_user_id` (operator-invited accounts,
 * see the Sourcing section above). Null when the caller represents no place
 * (the common case for ordinary buyer/seller accounts).
 */
export const myPlaceOutput = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: communityPlaceType,
    address: z.string().nullable(),
  })
  .nullable();

export type MyPlaceOutput = z.infer<typeof myPlaceOutput>;

// ---------------------------------------------------------------------------
// Legal — Terms of Service and Privacy Policy (F-052)
// Single source of truth rendered by the server (HTML pages) and mobile
// (native screen). See `legal.ts` for the drafting note and NOT-LEGAL-ADVICE
// disclaimer.
// ---------------------------------------------------------------------------

export type { LegalSection, LegalDocument } from "./legal.js";
export { TERMS_OF_SERVICE, PRIVACY_POLICY } from "./legal.js";
