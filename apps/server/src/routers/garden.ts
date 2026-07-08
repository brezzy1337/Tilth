/**
 * Garden router — F-047 growers' stories/reels feed.
 *
 * `feed`                  — public; PostGIS ST_DWithin/ST_Distance geo-scoped,
 *                            recency-ordered (created_at DESC, id DESC), keyset
 *                            cursor-paginated. Only `status = 'ready'` posts are
 *                            ever returned — a DB-only 'errored' status never
 *                            reaches the shared contract.
 * `createPhotoSet`        — seller-authed; photos are born "ready" (no encoding step).
 * `createPhotoUploadUrls` — seller-authed; V4 signed GCS PUT URLs for photo uploads.
 * `createVideo`           — seller-authed; creates a Mux direct upload and a
 *                            "processing" post; the Mux webhook (`webhook-mux.ts`)
 *                            flips it to "ready" once encoding finishes.
 *
 * Rules that must hold here:
 *   - No imports of env, db/index, gcs.ts, or mux.ts — everything via ctx
 *     (`ctx.media` / `ctx.mux`), so this file stays SDK-free and mobile-typecheck-safe.
 *   - All geo operations go through PostGIS — never app-side haversine math.
 *   - `ctx.media` / `ctx.mux` are `null` when the corresponding env vars are
 *     unset (Mux/GCS credentials do not exist yet for this pilot) — the
 *     affected procedures throw a clear PRECONDITION_FAILED rather than crash.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import {
  gardenPostType,
  gardenPostStatus,
  gardenPostPhoto,
  createGardenPostPhotoSetInput,
  createGardenPostVideoInput,
  createGardenPostVideoOutput,
  gardenFeedInput,
  gardenFeedOutput,
  type GardenFeedItem,
  type GardenPostPhoto,
} from "@homegrown/shared";
import { protectedProcedure, publicProcedure, router } from "../trpc";
import { gardenPosts } from "../db/schema";
import { resolveCallerStore, encodeKeysetCursor, decodeKeysetCursor } from "./helpers";

// ---------------------------------------------------------------------------
// Local output schemas — composed from shared primitives.
//
// NOTE: `packages/shared` is frozen for this task (F-047 ships with the
// contracts it already exports). There is no shared schema yet for a single
// created post (only the `gardenFeedItem` feed-row variants), so `createPhotoSet`'s
// response is defined here from shared building blocks (`gardenPostPhoto`,
// `gardenPostType`, `gardenPostStatus`) rather than redeclaring anything that
// already exists in shared. Promote this to shared in a follow-up if mobile
// needs to reuse the shape.
// ---------------------------------------------------------------------------

const createGardenPostPhotoSetOutput = z.object({
  id: z.string().uuid(),
  storeId: z.string().uuid(),
  type: gardenPostType,
  status: gardenPostStatus,
  caption: z.string(),
  photos: z.array(gardenPostPhoto),
  createdAt: z.string().datetime(),
});

/**
 * Input to `garden.createPhotoUploadUrls` — NOT part of `packages/shared`.
 * Small enough (and specific enough to the GCS upload mechanics) that it's
 * defined inline per the F-047 brief; promote to shared in a follow-up if
 * mobile needs to import it directly rather than relying on tRPC inference.
 */
const createPhotoUploadUrlsInput = z.object({
  count: z.number().int().min(1).max(10),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
});

const createPhotoUploadUrlsOutput = z.array(
  z.object({
    uploadUrl: z.string().url(),
    publicUrl: z.string().url(),
  }),
);

/** Maps an allowed upload content-type to its object-key file extension. */
const CONTENT_TYPE_EXT: Record<z.infer<typeof createPhotoUploadUrlsInput>["contentType"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// ---------------------------------------------------------------------------
// feed — raw-SQL row shape
// ---------------------------------------------------------------------------

interface FeedRow {
  id: string;
  store_id: string;
  store_name: string;
  type: "photo_set" | "video";
  status: "processing" | "ready" | "errored";
  caption: string;
  photos: unknown;
  mux_playback_id: string | null;
  duration_s: string | number | null;
  /**
   * postgres-js decodes timestamptz columns to Date via the driver's own type
   * parsers when going through the query builder, but a raw db.execute(sql``)
   * call (used here for the PostGIS joins) can return either shape depending
   * on the pg wire format negotiated — normalise defensively below.
   */
  created_at: Date | string;
  distance_m: string | number;
}

/** Normalise a driver-returned timestamp (Date or ISO string) to a Date. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toFeedItem(row: FeedRow): GardenFeedItem | null {
  const base = {
    id: row.id,
    storeId: row.store_id,
    storeName: row.store_name,
    distanceKm: Number(row.distance_m) / 1000,
    caption: row.caption,
    status: row.status as "processing" | "ready",
    createdAt: toDate(row.created_at).toISOString(),
  };

  if (row.type === "photo_set") {
    return {
      ...base,
      type: "photo_set",
      photos: Array.isArray(row.photos) ? (row.photos as GardenPostPhoto[]) : [],
    };
  }

  // video — status='ready' is only ever set alongside muxPlaybackId by the
  // Mux webhook (see webhook-mux.ts), so this should always be present. If a
  // row is ever missing it, skip it defensively rather than emit an invalid
  // (posterUrl-less) feed item.
  if (!row.mux_playback_id) return null;

  return {
    ...base,
    type: "video",
    muxPlaybackId: row.mux_playback_id,
    posterUrl: `https://image.mux.com/${row.mux_playback_id}/thumbnail.png`,
    durationS: row.duration_s !== null ? Number(row.duration_s) : undefined,
  };
}

export const gardenRouter = router({
  /**
   * Geo-scoped, recency-ordered garden posts feed (public).
   *
   * Mirrors `listings.nearby`'s PostGIS shape: ST_DWithin filters by radius,
   * ST_Distance computes distanceKm. Only `status = 'ready'` posts are
   * returned. Keyset-paginated on (created_at DESC, id DESC); cursor is an
   * opaque base64 "<createdAtISO>|<id>" string, same convention as
   * `orders.listForMyStore`.
   */
  feed: publicProcedure
    .input(gardenFeedInput)
    .output(gardenFeedOutput)
    .query(async ({ input, ctx }) => {
      const { lat, lng, radiusKm, cursor, limit } = input;
      const radiusMeters = radiusKm * 1000;

      let cursorCreatedAt: Date | null = null;
      let cursorId: string | null = null;
      if (cursor) {
        const decoded = decodeKeysetCursor(cursor);
        cursorCreatedAt = decoded.createdAt;
        cursorId = decoded.id;
      }

      // Bind as an ISO string, not a raw Date — the postgres.js driver's bind
      // path for ad-hoc db.execute(sql``) queries (as opposed to the query
      // builder) does not coerce Date instances itself.
      const cursorCreatedAtIso = cursorCreatedAt !== null ? cursorCreatedAt.toISOString() : null;
      const keysetFilter =
        cursorCreatedAtIso !== null && cursorId !== null
          ? sql`AND (p.created_at < ${cursorCreatedAtIso}::timestamptz OR (p.created_at = ${cursorCreatedAtIso}::timestamptz AND p.id < ${cursorId}))`
          : sql``;

      // Fetch limit+1 to detect whether there's a next page (same pattern as listForMyStore).
      const rows = await ctx.db.execute(sql`
        SELECT
          p.id,
          p.store_id,
          s.name AS store_name,
          p.type,
          p.status,
          p.caption,
          p.photos,
          p.mux_playback_id,
          p.duration_s,
          p.created_at,
          ST_Distance(loc.geog, ST_MakePoint(${lng}, ${lat})::geography) AS distance_m
        FROM garden_posts p
        JOIN stores s ON s.id = p.store_id
        JOIN locations loc ON loc.store_id = s.id
        WHERE p.status = 'ready'
        AND ST_DWithin(loc.geog, ST_MakePoint(${lng}, ${lat})::geography, ${radiusMeters})
        ${keysetFilter}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${limit + 1}
      `);

      const feedRows = rows as unknown as FeedRow[];

      let nextCursor: string | null = null;
      if (feedRows.length > limit) {
        const lastRow = feedRows[limit - 1]!;
        nextCursor = encodeKeysetCursor(toDate(lastRow.created_at), lastRow.id);
      }

      const pageRows = feedRows.slice(0, limit);
      const items = pageRows.map(toFeedItem).filter((item): item is GardenFeedItem => item !== null);

      return { items, nextCursor };
    }),

  /**
   * Create a photo-set garden post for the caller's store (seller-authed).
   * Born "ready" — there is no async encoding step for photos.
   *
   * When `GCS_MEDIA_BUCKET` is configured, every photo URL must point at that
   * bucket's public URL prefix (rejects foreign URLs). When the bucket is
   * unconfigured, this check is skipped (dev/test convenience).
   */
  createPhotoSet: protectedProcedure
    .input(createGardenPostPhotoSetInput)
    .output(createGardenPostPhotoSetOutput)
    .mutation(async ({ input, ctx }) => {
      const store = await resolveCallerStore(ctx.db, ctx.user.id);

      if (ctx.media) {
        const prefix = `https://storage.googleapis.com/${ctx.media.bucket}/`;
        const foreignUrl = input.photos.find((photo) => !photo.url.startsWith(prefix));
        if (foreignUrl) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Photo URLs must point at the configured media bucket",
          });
        }
      }

      const [inserted] = await ctx.db
        .insert(gardenPosts)
        .values({
          storeId: store.id,
          type: "photo_set",
          status: "ready",
          caption: input.caption,
          photos: input.photos,
        })
        .returning({
          id: gardenPosts.id,
          storeId: gardenPosts.storeId,
          type: gardenPosts.type,
          status: gardenPosts.status,
          caption: gardenPosts.caption,
          photos: gardenPosts.photos,
          createdAt: gardenPosts.createdAt,
        });

      if (!inserted) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create garden post",
        });
      }

      return {
        id: inserted.id,
        storeId: inserted.storeId,
        type: inserted.type,
        status: inserted.status as "processing" | "ready",
        caption: inserted.caption,
        photos: (inserted.photos as GardenPostPhoto[]) ?? [],
        createdAt: (inserted.createdAt ?? new Date()).toISOString(),
      };
    }),

  /**
   * Generate signed GCS upload URLs for `count` photos (seller-authed).
   *
   * Throws PRECONDITION_FAILED when `GCS_MEDIA_BUCKET` is unset — GCS
   * credentials/bucket configuration do not exist yet for this pilot.
   */
  createPhotoUploadUrls: protectedProcedure
    .input(createPhotoUploadUrlsInput)
    .output(createPhotoUploadUrlsOutput)
    .mutation(async ({ input, ctx }) => {
      if (!ctx.media) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Photo uploads not configured",
        });
      }
      const media = ctx.media;

      const store = await resolveCallerStore(ctx.db, ctx.user.id);
      const ext = CONTENT_TYPE_EXT[input.contentType];

      const urls = await Promise.all(
        Array.from({ length: input.count }, () => {
          const key = `garden/${store.id}/${crypto.randomUUID()}.${ext}`;
          return media.createUploadUrl({ key, contentType: input.contentType });
        }),
      );

      return urls;
    }),

  /**
   * Create a video garden post + Mux direct upload (seller-authed).
   *
   * Inserts the post as "processing" first, then asks Mux for a direct-upload
   * URL (passthrough = the new post's id, so the `video.asset.ready` /
   * `video.asset.errored` webhooks can correlate without a second lookup). On
   * Mux failure the post row is deleted so it doesn't linger stuck at
   * "processing" with no upload ever attempted.
   *
   * Throws PRECONDITION_FAILED when Mux credentials are unset.
   */
  createVideo: protectedProcedure
    .input(createGardenPostVideoInput)
    .output(createGardenPostVideoOutput)
    .mutation(async ({ input, ctx }) => {
      if (!ctx.mux) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Video uploads not configured",
        });
      }
      const mux = ctx.mux;

      const store = await resolveCallerStore(ctx.db, ctx.user.id);

      const [inserted] = await ctx.db
        .insert(gardenPosts)
        .values({
          storeId: store.id,
          type: "video",
          status: "processing",
          caption: input.caption,
          // Client-reported, advisory only — the Mux webhook overwrites this
          // with the authoritative duration once encoding finishes.
          durationS: input.durationS ?? null,
        })
        .returning({ id: gardenPosts.id });

      if (!inserted) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create garden post",
        });
      }

      let upload: { uploadId: string; uploadUrl: string };
      try {
        upload = await mux.createUpload({ passthrough: inserted.id });
      } catch (err) {
        console.error(
          "[garden.createVideo] Mux upload creation failed",
          err instanceof Error ? err.message : String(err),
        );
        // Don't leave an orphaned "processing" post with no upload ever attempted.
        await ctx.db.delete(gardenPosts).where(eq(gardenPosts.id, inserted.id));
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to start video upload",
        });
      }

      await ctx.db
        .update(gardenPosts)
        .set({ muxUploadId: upload.uploadId })
        .where(eq(gardenPosts.id, inserted.id));

      return { postId: inserted.id, uploadUrl: upload.uploadUrl };
    }),
});
