/**
 * Places router — F-048 community places (co-ops, health-food stores,
 * farmers markets) pinned on the Home map.
 *
 * `nearby` is the only procedure: public, PostGIS ST_DWithin/ST_Distance,
 * ORDER BY distance ASC, LIMIT 200, `status = 'approved'` only (pending/
 * rejected imports are never served), optional `type` filter.
 *
 * Rows are populated exclusively by the operator-run import CLI
 * (`scripts/import-places.ts`) — there is no write procedure here. That CLI
 * talks directly to Postgres, not this router.
 *
 * All geo operations go through PostGIS — never app-side haversine math.
 * No direct imports of env, db, or any helper with side-effects.
 */

import { placesNearbyInput, placesNearbyOutput, type CommunityPlaceType } from "@homegrown/shared";
import { sql } from "drizzle-orm";
import { publicProcedure, router } from "../trpc";
import { geoRadius } from "./helpers";

export const placesRouter = router({
  /**
   * Find approved community places near a lat/lng coordinate (public).
   *
   * PostGIS ST_DWithin filters by radius, ST_Distance computes the distance,
   * ordered ascending. Capped at 200 results (placesNearbyOutput's max).
   * Optional `type` filter. Never does app-side distance math.
   */
  nearby: publicProcedure
    .input(placesNearbyInput)
    .output(placesNearbyOutput)
    .query(async ({ input, ctx }) => {
      const { lat, lng, radiusKm, type } = input;
      const geo = geoRadius(lat, lng, radiusKm);
      const geogColumn = sql`cp.location`;

      // Build type filter clause — omit entirely when not supplied. `type`
      // is bound as a parameter (no SQL injection); it is also validated
      // against communityPlaceType by the input schema before we get here.
      const typeFilter = type ? sql`AND cp.type = ${type}` : sql``;

      type NearbyPlaceRow = {
        id: string;
        type: string;
        name: string;
        address: string | null;
        website: string | null;
        hours_text: string | null;
        distance_m: string | number;
        lat: string | number;
        lng: string | number;
      };

      const rows = await ctx.db.execute(sql`
        SELECT
          cp.id,
          cp.type,
          cp.name,
          cp.address,
          cp.website,
          cp.hours_text,
          ${geo.distanceExpr(geogColumn)} AS distance_m,
          ST_Y(cp.location::geometry) AS lat,
          ST_X(cp.location::geometry) AS lng
        FROM community_places cp
        WHERE cp.status = 'approved'
        AND ${geo.withinClause(geogColumn)}
        ${typeFilter}
        ORDER BY ${geo.distanceExpr(geogColumn)} ASC
        LIMIT 200
      `);

      return rows.map((r) => {
        const row = r as NearbyPlaceRow;
        return {
          id: row.id,
          type: row.type as CommunityPlaceType,
          name: row.name,
          lat: Number(row.lat),
          lng: Number(row.lng),
          address: row.address,
          website: row.website,
          hoursText: row.hours_text,
          distanceKm: Number(row.distance_m) / 1000,
        };
      });
    }),
});
