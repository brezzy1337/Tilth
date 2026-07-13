/**
 * Places router — F-048 community places (co-ops, health-food stores,
 * farmers markets) pinned on the Home map. F-049 adds the `linkedUserId`
 * dimension (operator-invited buyer accounts) that sourcing requests hang
 * off of.
 *
 * `nearby` — public, PostGIS ST_DWithin/ST_Distance, ORDER BY distance ASC,
 *   LIMIT 200, `status = 'approved'` only (pending/rejected imports are never
 *   served), optional `type` filter. `acceptsOffers` reflects whether the
 *   place has a linked buyer account (F-049) — drives the mobile "Offer to
 *   supply" CTA.
 * `mine`    — protected; the approved place linked to the caller's account,
 *   or null if the caller represents no place (the common case).
 *
 * Rows (and `linkedUserId`) are populated exclusively by the operator-run
 * CLIs (`scripts/import-places.ts`, `scripts/link-place-buyer.ts`) — there is
 * no write procedure here. Those CLIs talk directly to Postgres, not this
 * router.
 *
 * All geo operations go through PostGIS — never app-side haversine math.
 * No direct imports of env, db, or any helper with side-effects.
 */

import {
  placesNearbyInput,
  placesNearbyOutput,
  myPlaceOutput,
  type CommunityPlaceType,
} from "@homegrown/shared";
import { sql } from "drizzle-orm";
import { publicProcedure, protectedProcedure, router } from "../trpc";
import { geoRadius, findLinkedApprovedPlace, activeUserClause } from "./helpers";

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
        accepts_offers: boolean;
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
          ST_X(cp.location::geometry) AS lng,
          -- F-051: a place "accepts offers" only if it has a linked buyer AND
          -- that buyer's account isn't deactivated. LEFT JOIN so places with
          -- no linked user still return a row (lu.deactivated_at is then NULL,
          -- but the linked_user_id IS NOT NULL half of the AND already fails).
          (cp.linked_user_id IS NOT NULL AND ${activeUserClause(sql`lu`)}) AS accepts_offers
        FROM community_places cp
        LEFT JOIN users lu ON lu.id = cp.linked_user_id
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
          acceptsOffers: row.accepts_offers,
        };
      });
    }),

  /**
   * The approved community place linked to the caller's account (F-049
   * operator-invited buyer), or null when the caller represents no place —
   * the common case for ordinary buyer/seller accounts.
   */
  mine: protectedProcedure.output(myPlaceOutput).query(async ({ ctx }) => {
    const place = await findLinkedApprovedPlace(ctx.db, ctx.user.id);

    if (!place) return null;

    return {
      id: place.id,
      name: place.name,
      type: place.type as CommunityPlaceType,
      address: place.address,
    };
  }),
});
