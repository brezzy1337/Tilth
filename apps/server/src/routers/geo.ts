/**
 * Geo router — store location management.
 *
 * `setStoreLocation` geocodes a structured address via the injected `ctx.geocode`
 * capability and upserts the store's PostGIS geography point. One location per
 * store is enforced via a unique constraint on `store_id`.
 *
 * All geo operations go through PostGIS — never app-side haversine math.
 * No direct imports of env, db, or geocode.ts — everything via context.
 */

import { TRPCError } from "@trpc/server";
import { setStoreLocationInput, location as locationSchema } from "@homegrown/shared";
import { sql } from "drizzle-orm";
import { protectedProcedure, router } from "../trpc";
import { locations } from "../db/schema";
import { resolveCallerStore } from "./helpers";

export const geoRouter = router({
  /**
   * Geocode an address and upsert the caller's store location.
   * Protected — requires a valid Bearer token.
   * One location per store (upsert on the unique storeId constraint).
   */
  setStoreLocation: protectedProcedure
    .input(setStoreLocationInput)
    .output(locationSchema)
    .mutation(async ({ input, ctx }) => {
      // Resolve the caller's store (throws NOT_FOUND if absent)
      const store = await resolveCallerStore(ctx.db, ctx.user.id);

      // Geocode the address via the injected capability
      const coords = await ctx.geocode(input);
      if (!coords) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Could not locate that address",
        });
      }

      const { lat, lng } = coords;

      // Hoist the geography point so lng/lat order is defined exactly once.
      const geogPoint = sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;

      // Upsert: insert or update on store_id conflict
      const [upserted] = await ctx.db
        .insert(locations)
        .values({
          storeId: store.id,
          address: input.address,
          city: input.city,
          state: input.state,
          zip: input.zip,
          geog: geogPoint,
        })
        .onConflictDoUpdate({
          target: locations.storeId,
          set: {
            address: input.address,
            city: input.city,
            state: input.state,
            zip: input.zip,
            geog: geogPoint,
            updatedAt: sql`now()`,
          },
        })
        .returning({
          id: locations.id,
          storeId: locations.storeId,
          address: locations.address,
          city: locations.city,
          state: locations.state,
          zip: locations.zip,
        });

      if (!upserted) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to save location",
        });
      }

      return {
        id: upserted.id,
        storeId: upserted.storeId,
        address: upserted.address,
        city: upserted.city,
        state: upserted.state,
        zip: upserted.zip,
        lat,
        lng,
      };
    }),
});
