/**
 * Listings router — CRUD + nearby PostGIS browse.
 *
 * - `create`: protected; store inferred from ctx.user.id.
 * - `update`: protected; must own the listing's store.
 * - `listByStore`: public; returns all listings for a store.
 * - `nearby`: public; PostGIS ST_DWithin/ST_Distance, ORDER BY distance, LIMIT 50.
 *
 * All geo operations go through PostGIS — never app-side haversine math.
 * No direct imports of env, db, or any helper with side-effects.
 */

import { TRPCError } from "@trpc/server";
import {
  createListingInput,
  updateListingInput,
  listByStoreInput,
  nearbyInput,
  listing as listingSchema,
  nearbyListing as nearbyListingSchema,
  type ListingCategory,
  type ListingUnit,
} from "@homegrown/shared";
import { eq, sql } from "drizzle-orm";
import { publicProcedure, protectedProcedure, router } from "../trpc";
import { stores, listings } from "../db/schema";
import { geoRadius, resolveCallerStore } from "./helpers";

/** Columns returned by all listing queries. */
const listingCols = {
  id: listings.id,
  storeId: listings.storeId,
  name: listings.name,
  category: listings.category,
  priceCents: listings.priceCents,
  quantity: listings.quantity,
  unit: listings.unit,
  attributes: listings.attributes,
  createdAt: listings.createdAt,
  updatedAt: listings.updatedAt,
} as const;

type ListingRow = {
  id: string;
  storeId: string;
  name: string;
  category: ListingCategory;
  priceCents: number;
  quantity: number;
  unit: ListingUnit;
  attributes: unknown;
  createdAt: Date | null;
  updatedAt: Date | null;
};

function toListingOutput(r: ListingRow) {
  return {
    id: r.id,
    storeId: r.storeId,
    name: r.name,
    category: r.category,
    priceCents: r.priceCents,
    quantity: r.quantity,
    unit: r.unit,
    attributes: (r.attributes as Record<string, unknown>) ?? null,
    createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: r.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

export const listingsRouter = router({
  /**
   * Create a listing for the authenticated user's store.
   * Protected — store is inferred from ctx.user.id.
   */
  create: protectedProcedure
    .input(createListingInput)
    .output(listingSchema)
    .mutation(async ({ input, ctx }) => {
      // Resolve the caller's store (throws NOT_FOUND if absent)
      const store = await resolveCallerStore(ctx.db, ctx.user.id);

      const [inserted] = await ctx.db
        .insert(listings)
        .values({
          storeId: store.id,
          name: input.name,
          category: input.category,
          priceCents: input.priceCents,
          quantity: input.quantity,
          unit: input.unit,
          attributes: input.attributes ?? null,
        })
        .returning(listingCols);

      if (!inserted) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create listing",
        });
      }

      return toListingOutput(inserted as ListingRow);
    }),

  /**
   * Update an existing listing.
   * Protected — caller must own the listing's store.
   * Only supplied fields are updated; bumps updatedAt.
   */
  update: protectedProcedure
    .input(updateListingInput)
    .output(listingSchema)
    .mutation(async ({ input, ctx }) => {
      const { listingId, ...fields } = input;

      // Fetch the listing and its store to verify ownership
      const [existing] = await ctx.db
        .select({
          id: listings.id,
          storeId: listings.storeId,
          userId: stores.userId,
        })
        .from(listings)
        .innerJoin(stores, eq(listings.storeId, stores.id))
        .where(eq(listings.id, listingId))
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Listing not found",
        });
      }

      if (existing.userId !== ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not own this listing",
        });
      }

      // Build a typed update object using Partial to match Drizzle's set() expectation
      type ListingUpdate = {
        name?: string;
        category?: ListingCategory;
        priceCents?: number;
        quantity?: number;
        unit?: ListingUnit;
        attributes?: unknown;
        updatedAt: ReturnType<typeof sql>;
      };

      const updateSet: ListingUpdate = {
        updatedAt: sql`now()`,
      };
      if (fields.name !== undefined) updateSet.name = fields.name;
      if (fields.category !== undefined) updateSet.category = fields.category;
      if (fields.priceCents !== undefined) updateSet.priceCents = fields.priceCents;
      if (fields.quantity !== undefined) updateSet.quantity = fields.quantity;
      if (fields.unit !== undefined) updateSet.unit = fields.unit;
      // attributes is nullish — update if explicitly included in input
      if ("attributes" in input) updateSet.attributes = fields.attributes ?? null;

      const [updated] = await ctx.db
        .update(listings)
        .set(updateSet)
        .where(eq(listings.id, listingId))
        .returning(listingCols);

      if (!updated) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update listing",
        });
      }

      return toListingOutput(updated as ListingRow);
    }),

  /**
   * List all listings for a store (public).
   */
  listByStore: publicProcedure
    .input(listByStoreInput)
    .output(listingSchema.array())
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select(listingCols)
        .from(listings)
        .where(eq(listings.storeId, input.storeId));

      return rows.map((r) => toListingOutput(r as ListingRow));
    }),

  /**
   * Find listings near a lat/lng coordinate (public).
   *
   * PostGIS ST_DWithin filters by radius, ST_Distance computes the distance,
   * ordered ascending. Capped at 50 results. Optional category filter.
   * Optional case-insensitive substring name search via `query` (ILIKE, parameterized).
   * Never does app-side distance math.
   */
  nearby: publicProcedure
    .input(nearbyInput)
    .output(nearbyListingSchema.array())
    .query(async ({ input, ctx }) => {
      const { lat, lng, radiusKm, category, query } = input;
      const geo = geoRadius(lat, lng, radiusKm);
      const geogColumn = sql`loc.geog`;

      // Build category filter clause — omit entirely when not supplied
      const categoryFilter = category
        ? sql`AND l.category = ${category}::"listing_category"`
        : sql``;

      // Build name filter clause — case-insensitive substring match.
      // `query` is a bound parameter (no SQL injection). We ALSO escape the LIKE
      // metacharacters %, _ and \ in the user value (with an explicit ESCAPE '\')
      // so a `%`-laden query can't turn into a match-everything full-table scan on
      // this unauthenticated endpoint — only the outer literal '%' wildcards do
      // substring matching; the user's own %/_ are treated literally.
      const escapedQuery = query?.replace(/[%_\\]/g, "\\$&");
      const nameFilter = escapedQuery
        ? sql`AND l.name ILIKE '%' || ${escapedQuery} || '%' ESCAPE '\'`
        : sql``;

      type NearbyRow = {
        id: string;
        name: string;
        category: string;
        price_cents: string | number;
        quantity: string | number;
        unit: string;
        store_id: string;
        store_name: string;
        distance_m: string | number;
        lat: string | number;
        lng: string | number;
      };

      const rows = await ctx.db.execute(sql`
        SELECT
          l.id,
          l.name,
          l.category,
          l.price_cents,
          l.quantity,
          l.unit,
          l.store_id,
          s.name AS store_name,
          ${geo.distanceExpr(geogColumn)} AS distance_m,
          ST_Y(loc.geog::geometry) AS lat,
          ST_X(loc.geog::geometry) AS lng
        FROM listings l
        JOIN stores s ON s.id = l.store_id
        JOIN locations loc ON loc.store_id = s.id
        WHERE ${geo.withinClause(geogColumn)}
        ${categoryFilter}
        ${nameFilter}
        ORDER BY ${geo.distanceExpr(geogColumn)} ASC
        LIMIT 50
      `);

      return rows.map((r) => {
        const row = r as NearbyRow;
        return {
          id: row.id,
          name: row.name,
          category: row.category as ListingCategory,
          priceCents: Number(row.price_cents),
          quantity: Number(row.quantity),
          unit: row.unit as ListingUnit,
          storeId: row.store_id,
          storeName: row.store_name,
          distanceKm: Number(row.distance_m) / 1000,
          lat: Number(row.lat),
          lng: Number(row.lng),
        };
      });
    }),
});
