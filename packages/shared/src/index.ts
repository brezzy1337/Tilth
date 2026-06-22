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
 * Public store profile returned by `stores.get` and `stores.getMine`.
 * `stripeConnectAccountId` is included so the mobile client can detect whether
 * the seller has completed Connect Express onboarding, but it carries no secret
 * (the account ID is not a credential).
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
export const createOrderInput = z.object({
  items: z.array(orderItem).min(1).max(50),
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
  subtotalCents: z.number().int(),
  applicationFeeCents: z.number().int(),
  totalCents: z.number().int(),
  stripePaymentIntentId: z.string().nullable(),
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
