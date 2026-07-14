/**
 * Garden router — F-047 growers' stories/reels feed + F-053 social layer
 * (likes, flat comments, per-post share link support).
 *
 * `feed`                  — public; PostGIS ST_DWithin/ST_Distance geo-scoped,
 *                            recency-ordered (created_at DESC, id DESC), keyset
 *                            cursor-paginated. Only `status = 'ready'` posts are
 *                            ever returned — a DB-only 'errored' status never
 *                            reaches the shared contract. F-053 — every row also
 *                            carries `likeCount`/`likedByMe`/`commentCount`,
 *                            computed via LEFT JOIN LATERAL (no N+1: one query
 *                            total, same page-of-rows shape as before).
 * `createPhotoSet`        — seller-authed; photos are born "ready" (no encoding step).
 * `createPhotoUploadUrls` — seller-authed; V4 signed GCS PUT URLs for photo uploads.
 * `createVideo`           — seller-authed; creates a Mux direct upload and a
 *                            "processing" post; the Mux webhook (`webhook-mux.ts`)
 *                            flips it to "ready" once encoding finishes.
 * `toggleLike`            — authed; post must be feed-visible (NOT_FOUND
 *                            otherwise); toggles the caller's like row
 *                            (delete-if-exists else ON CONFLICT DO NOTHING
 *                            insert — the delete's row count is the source of
 *                            truth for the new `liked` state, race-safe under
 *                            concurrent toggles from the same user).
 *
 * `createComment`/`listComments`/`deleteComment`/`reportComment` — flat
 * (no threads) comments on a garden post, all on THIS router (not split out)
 * since every comment operation first resolves + authorizes against a garden
 * post via `resolveVisibleGardenPost`, the ONE feed-visibility predicate
 * (status='ready' AND owner not deactivated) shared with `feed`/`toggleLike`.
 * NOTE: `packages/shared`'s doc comments refer to these as `gardenComments.*`
 * — that's the CONTRACT's descriptive naming, not the mount point; the actual
 * tRPC path is `garden.createComment` etc. (this router, mounted as `garden`
 * in `router.ts`). Flag to mobile if a separate `gardenComments` namespace is
 * expected instead.
 *
 * Rules that must hold here:
 *   - No imports of env, db/index, gcs.ts, or mux.ts — everything via ctx
 *     (`ctx.media` / `ctx.mux`), so this file stays SDK-free and mobile-typecheck-safe.
 *   - All geo operations go through PostGIS — never app-side haversine math.
 *   - `ctx.media` / `ctx.mux` are `null` when the corresponding env vars are
 *     unset (Mux/GCS credentials do not exist yet for this pilot) — the
 *     affected procedures throw a clear PRECONDITION_FAILED rather than crash.
 *   - F-051 — all three post-creation procedures call helpers.ts's
 *     `assertCallerActive` (a deactivated caller can't create new posts). It
 *     runs AFTER the media/mux-configured check on `createPhotoUploadUrls` /
 *     `createVideo` so the "unconfigured" path still never touches the DB.
 *     F-053 — of its five procedures, the four WRITES (`toggleLike`,
 *     `createComment`, `deleteComment`, `reportComment`) all call it FIRST,
 *     before any other authz/state check; `listComments` is a public read and
 *     does not (a deactivated caller can still browse — only writes are
 *     blocked, per helpers.ts's CALLER-direction note).
 *   - F-053 — comment writes reuse helpers.ts's `isBlockedEitherDirection` (a
 *     commenter blocked either-direction with the POST OWNER is FORBIDDEN,
 *     same semantics as chat.ts, which also uses it — moved to helpers.ts once
 *     a third router needed it) and helpers.ts's `pushToUser`/`activeUserClause`.
 *     A missing/invisible post or comment is always NOT_FOUND, never FORBIDDEN
 *     (existence isn't leaked — same convention as chat.ts).
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, and, or, lt, desc, count, isNull, notInArray, sql } from "drizzle-orm";
import {
  gardenPostType,
  gardenPostStatus,
  gardenPostPhoto,
  createGardenPostPhotoSetInput,
  createGardenPostVideoInput,
  createGardenPostVideoOutput,
  gardenFeedInput,
  gardenFeedOutput,
  toggleGardenLikeInput,
  toggleGardenLikeOutput,
  createGardenCommentInput,
  createGardenCommentOutput,
  listGardenCommentsInput,
  listGardenCommentsOutput,
  deleteGardenCommentInput,
  reportGardenCommentInput,
  type GardenFeedItem,
  type GardenPostPhoto,
  type GardenComment,
} from "@homegrown/shared";
import { protectedProcedure, publicProcedure, router } from "../trpc";
import {
  gardenPosts,
  gardenPostLikes,
  gardenPostComments,
  gardenCommentReports,
  stores,
  users,
  userBlocks,
} from "../db/schema";
import {
  resolveCallerStore,
  encodeKeysetCursor,
  decodeKeysetCursor,
  geoRadius,
  activeUserClause,
  assertCallerActive,
  pushToUser,
  isBlockedEitherDirection,
  assertRateLimit,
} from "./helpers";
import type { Db } from "../context";

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
const CONTENT_TYPE_EXT: Record<z.infer<typeof createPhotoUploadUrlsInput>["contentType"], string> =
  {
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
  /** F-053 — total likes on this post. Always present (COALESCEd to 0 in SQL). */
  like_count: string | number;
  /** F-053 — whether the requesting caller liked this post. False when unauthenticated. */
  liked_by_me: boolean;
  /** F-053 — non-deleted, active-author comment count. Always present (COALESCEd to 0 in SQL). */
  comment_count: string | number;
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
    likeCount: Number(row.like_count),
    likedByMe: row.liked_by_me,
    commentCount: Number(row.comment_count),
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

// ---------------------------------------------------------------------------
// F-053 — shared visibility predicate + rate limits for the social layer
// ---------------------------------------------------------------------------

/** The subset of a garden post needed by `toggleLike`/comment procedures. */
interface VisibleGardenPost {
  id: string;
  storeId: string;
  ownerUserId: string;
}

/** The subset of a `garden_posts` ⋈ `users` row needed to decide visibility. */
interface GardenPostVisibilityRow {
  status: string;
  ownerDeactivatedAt: Date | null;
}

/**
 * THE ONE visibility predicate for a garden post, outside of `feed`'s
 * necessarily-raw-SQL WHERE clause (which filters at the DB rather than in
 * application code, and must be kept in sync with this by hand — see the
 * comment on `feed`'s WHERE clause below): `status = 'ready'` AND the owning
 * store's user is not deactivated. Used by both `resolveVisibleGardenPost`
 * (throwing variant, for `toggleLike`/comments) and `fetchGardenPostForShare`
 * (null-returning variant, for the public share page).
 */
function isGardenPostVisible(row: GardenPostVisibilityRow): boolean {
  return row.status === "ready" && row.ownerDeactivatedAt === null;
}

/**
 * Resolve a garden post and enforce `isGardenPostVisible` — throws NOT_FOUND
 * otherwise (existence isn't leaked; a "processing"/"errored" post or one
 * owned by a deactivated seller looks identical to a nonexistent one). Used
 * by `toggleLike`, `createComment`, `listComments`, and the public share page
 * (`garden-share-html.ts`).
 */
async function resolveVisibleGardenPost(db: Db, postId: string): Promise<VisibleGardenPost> {
  const [row] = await db
    .select({
      id: gardenPosts.id,
      storeId: gardenPosts.storeId,
      status: gardenPosts.status,
      ownerUserId: users.id,
      ownerDeactivatedAt: users.deactivatedAt,
    })
    .from(gardenPosts)
    .innerJoin(stores, eq(stores.id, gardenPosts.storeId))
    .innerJoin(users, eq(users.id, stores.userId))
    .where(eq(gardenPosts.id, postId))
    .limit(1);

  if (!row || !isGardenPostVisible(row)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Garden post not found" });
  }

  return { id: row.id, storeId: row.storeId, ownerUserId: row.ownerUserId };
}

/** A single garden post's display fields, as needed by the public share page (`garden-share-html.ts`). */
export interface GardenSharePost {
  id: string;
  storeName: string;
  caption: string;
  type: "photo_set" | "video";
  photos: GardenPostPhoto[];
  muxPlaybackId: string | null;
  durationS: number | null;
  createdAt: string;
}

/**
 * Fetch a single feed-visible garden post for the public share page
 * (`GET /garden/{postId}`, see `garden-share-html.ts`). Same `isGardenPostVisible`
 * predicate as `feed`/`toggleLike`/comments (status='ready', owner not
 * deactivated). Returns `null` (never throws) when the post doesn't exist or
 * isn't visible — the share-page handler maps that to a 404 HTML page.
 * `postId` MUST already be validated as a UUID by the caller — an
 * arbitrary string bound against the `uuid` column throws a Postgres error
 * rather than resolving to "no row".
 */
export async function fetchGardenPostForShare(
  db: Db,
  postId: string,
): Promise<GardenSharePost | null> {
  const [row] = await db
    .select({
      id: gardenPosts.id,
      storeName: stores.name,
      caption: gardenPosts.caption,
      type: gardenPosts.type,
      photos: gardenPosts.photos,
      muxPlaybackId: gardenPosts.muxPlaybackId,
      durationS: gardenPosts.durationS,
      createdAt: gardenPosts.createdAt,
      status: gardenPosts.status,
      ownerDeactivatedAt: users.deactivatedAt,
    })
    .from(gardenPosts)
    .innerJoin(stores, eq(stores.id, gardenPosts.storeId))
    .innerJoin(users, eq(users.id, stores.userId))
    .where(eq(gardenPosts.id, postId))
    .limit(1);

  if (!row || !isGardenPostVisible(row)) return null;

  return {
    id: row.id,
    storeName: row.storeName,
    caption: row.caption,
    type: row.type,
    photos: Array.isArray(row.photos) ? (row.photos as GardenPostPhoto[]) : [],
    muxPlaybackId: row.muxPlaybackId,
    durationS: row.durationS !== null ? Number(row.durationS) : null,
    createdAt: toDate(row.createdAt ?? new Date()).toISOString(),
  };
}

/** `createComment`: max comments per commenter (across ALL posts) per window — mirrors chat.ts's SEND_RATE_LIMIT. */
const GARDEN_COMMENT_RATE_LIMIT = { max: 30, windowMs: 60_000 };
/** `reportComment`: max reports per reporter per window — mirrors chat.ts's REPORT_RATE_LIMIT. */
const GARDEN_COMMENT_REPORT_RATE_LIMIT = { max: 10, windowMs: 60 * 60_000 };

/**
 * Throw TOO_MANY_REQUESTS when a commenter has hit the `createComment` window.
 * Thin wrapper over helpers.ts's generic `assertRateLimit`. Exported for garden.test.ts.
 */
export async function assertGardenCommentRateLimit(db: Db, userId: string): Promise<void> {
  return assertRateLimit(db, {
    table: gardenPostComments,
    userIdColumn: gardenPostComments.userId,
    createdAtColumn: gardenPostComments.createdAt,
    userId,
    max: GARDEN_COMMENT_RATE_LIMIT.max,
    windowMs: GARDEN_COMMENT_RATE_LIMIT.windowMs,
    message: "You're commenting too quickly. Please wait a moment.",
  });
}

/** Throw TOO_MANY_REQUESTS when a reporter has hit the `reportComment` window. */
async function assertGardenCommentReportRateLimit(db: Db, reporterUserId: string): Promise<void> {
  return assertRateLimit(db, {
    table: gardenCommentReports,
    userIdColumn: gardenCommentReports.reporterUserId,
    createdAtColumn: gardenCommentReports.createdAt,
    userId: reporterUserId,
    max: GARDEN_COMMENT_REPORT_RATE_LIMIT.max,
    windowMs: GARDEN_COMMENT_REPORT_RATE_LIMIT.windowMs,
    message: "Too many reports. Please try again later.",
  });
}

/**
 * Every user id blocked-either-direction with `callerId` (the caller blocked
 * them, or they blocked the caller) — used by `listComments` to filter out
 * comments from either side of a block. Returns `[]` for a caller with no
 * blocks (the common case), so callers can skip the `notInArray` filter
 * entirely when this is empty.
 */
async function blockedEitherDirectionUserIds(db: Db, callerId: string): Promise<string[]> {
  const rows = await db
    .select({ blockerUserId: userBlocks.blockerUserId, blockedUserId: userBlocks.blockedUserId })
    .from(userBlocks)
    .where(or(eq(userBlocks.blockerUserId, callerId), eq(userBlocks.blockedUserId, callerId)));

  const ids = new Set<string>();
  for (const row of rows) {
    if (row.blockerUserId === callerId) ids.add(row.blockedUserId);
    if (row.blockedUserId === callerId) ids.add(row.blockerUserId);
  }
  return [...ids];
}

/** Map a `garden_post_comments` ⋈ `users` row to the shared `GardenComment` DTO. */
function toGardenCommentDto(row: {
  id: string;
  postId: string;
  userId: string;
  username: string;
  body: string;
  deleted: boolean;
  createdAt: Date | string | null;
}): GardenComment {
  return {
    id: row.id,
    postId: row.postId,
    userId: row.userId,
    username: row.username,
    body: row.deleted ? "" : row.body,
    createdAt: toDate(row.createdAt ?? new Date()).toISOString(),
    deleted: row.deleted,
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
      const geo = geoRadius(lat, lng, radiusKm);
      const geogColumn = sql`loc.geog`;

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

      // F-053 — likeCount/commentCount via LEFT JOIN LATERAL (one query total,
      // no N+1 — each lateral is a per-row correlated subquery, index-assisted
      // by garden_post_likes_post_id_idx / garden_post_comments_post_id_created_at_id_idx).
      // likedByMe is caller-specific; the lateral + select fragment are both
      // omitted entirely for an unauthenticated caller rather than binding a
      // null user id, so `feed` stays a genuinely public query.
      const callerId = ctx.user?.id ?? null;
      const likedByMeJoin = callerId
        ? sql`LEFT JOIN LATERAL (
            SELECT true AS liked FROM garden_post_likes gpl2
            WHERE gpl2.post_id = p.id AND gpl2.user_id = ${callerId}
            LIMIT 1
          ) lm ON true`
        : sql``;
      const likedByMeSelect = callerId
        ? sql`COALESCE(lm.liked, false) AS liked_by_me`
        : sql`false AS liked_by_me`;

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
          ${geo.distanceExpr(geogColumn)} AS distance_m,
          COALESCE(lc.like_count, 0) AS like_count,
          ${likedByMeSelect},
          COALESCE(cc.comment_count, 0) AS comment_count
        FROM garden_posts p
        JOIN stores s ON s.id = p.store_id
        JOIN locations loc ON loc.store_id = s.id
        JOIN users u ON u.id = s.user_id
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS like_count FROM garden_post_likes gpl
          WHERE gpl.post_id = p.id
        ) lc ON true
        ${likedByMeJoin}
        LEFT JOIN LATERAL (
          -- Non-deleted, active-author comments only — matches exactly what
          -- gardenComments.list shows an unblocked viewer (see its doc comment).
          SELECT count(*)::int AS comment_count
          FROM garden_post_comments gc
          JOIN users cu ON cu.id = gc.user_id
          WHERE gc.post_id = p.id AND gc.deleted = false AND ${activeUserClause(sql`cu`)}
        ) cc ON true
        -- p.status = 'ready' AND activeUserClause(u) together are this raw-SQL
        -- query's necessarily-hand-written form of isGardenPostVisible (see
        -- that predicate above) — must stay in sync with it by hand; a "feed
        -- visible" post here MUST match a "feed visible" post everywhere else
        -- (toggleLike/comments/the public share page).
        WHERE p.status = 'ready'
        AND ${geo.withinClause(geogColumn)}
        AND ${activeUserClause(sql`u`)}
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
      const items = pageRows
        .map(toFeedItem)
        .filter((item): item is GardenFeedItem => item !== null);

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
      await assertCallerActive(ctx.db, ctx.user.id);

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

      await assertCallerActive(ctx.db, ctx.user.id);

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

      await assertCallerActive(ctx.db, ctx.user.id);

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

  // -------------------------------------------------------------------------
  // F-053 — likes
  // -------------------------------------------------------------------------

  /**
   * Toggle the caller's like on a garden post (authed).
   *
   * NOT_FOUND when the post doesn't exist or isn't feed-visible (same
   * predicate as `feed`). Delete-then-maybe-insert, where the DELETE's row
   * count (not a preceding SELECT) decides whether to insert: this prevents
   * duplicate like rows and avoids a unique-constraint crash under concurrent
   * toggles from the same user — the losing racer's INSERT is a silent ON
   * CONFLICT DO NOTHING no-op. It does NOT guarantee linearizable toggle
   * semantics, though: two simultaneous toggles from the same user can each
   * act on a stale view of "liked", so the `liked` value returned to the
   * losing racer may not match the post's actual final state (self-corrects
   * on the next toggle, or on the next `feed`/`listComments` refetch).
   */
  toggleLike: protectedProcedure
    .input(toggleGardenLikeInput)
    .output(toggleGardenLikeOutput)
    .mutation(async ({ input, ctx }) => {
      await assertCallerActive(ctx.db, ctx.user.id);

      const post = await resolveVisibleGardenPost(ctx.db, input.postId);

      const deletedRows = await ctx.db
        .delete(gardenPostLikes)
        .where(and(eq(gardenPostLikes.postId, post.id), eq(gardenPostLikes.userId, ctx.user.id)))
        .returning({ postId: gardenPostLikes.postId });

      let liked: boolean;
      if (deletedRows.length > 0) {
        liked = false;
      } else {
        await ctx.db
          .insert(gardenPostLikes)
          .values({ postId: post.id, userId: ctx.user.id })
          .onConflictDoNothing();
        liked = true;
      }

      const [row] = await ctx.db
        .select({ count: count() })
        .from(gardenPostLikes)
        .where(eq(gardenPostLikes.postId, post.id));

      return { liked, likeCount: row?.count ?? 0 };
    }),

  // -------------------------------------------------------------------------
  // F-053 — flat comments (no threads)
  // -------------------------------------------------------------------------

  /**
   * Create a comment on a garden post (authed).
   *
   * NOT_FOUND when the post is missing/invisible; FORBIDDEN (generic — never
   * reveals who blocked whom) when the commenter and the POST OWNER block
   * each other in either direction (same semantics as chat.ts's `send`);
   * TOO_MANY_REQUESTS past 30 comments/60s per commenter (mirrors chat's
   * `send` rate limit, counted across ALL posts). Sends a best-effort push to
   * the post owner after the write commits — skipped when commenting on your
   * own post.
   */
  createComment: protectedProcedure
    .input(createGardenCommentInput)
    .output(createGardenCommentOutput)
    .mutation(async ({ input, ctx }) => {
      await assertCallerActive(ctx.db, ctx.user.id);

      const post = await resolveVisibleGardenPost(ctx.db, input.postId);

      if (await isBlockedEitherDirection(ctx.db, ctx.user.id, post.ownerUserId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can't comment on this post",
        });
      }

      await assertGardenCommentRateLimit(ctx.db, ctx.user.id);

      const [inserted] = await ctx.db
        .insert(gardenPostComments)
        .values({ postId: post.id, userId: ctx.user.id, body: input.body })
        .returning({ id: gardenPostComments.id, createdAt: gardenPostComments.createdAt });

      if (!inserted) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create comment",
        });
      }

      const [callerRow] = await ctx.db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);

      // Best-effort push to the post owner, AFTER the write commits — awaited
      // per pushToUser's Cloud Run rationale (see helpers.ts). Skipped when
      // the commenter owns the post themselves.
      if (post.ownerUserId !== ctx.user.id) {
        await pushToUser(
          ctx.db,
          ctx.push,
          post.ownerUserId,
          "New comment on your garden post",
          input.body,
          { postId: post.id },
        );
      }

      return toGardenCommentDto({
        id: inserted.id,
        postId: post.id,
        userId: ctx.user.id,
        username: callerRow?.username ?? "",
        body: input.body,
        deleted: false,
        createdAt: inserted.createdAt,
      });
    }),

  /**
   * Newest-first, keyset-paginated comments on a garden post.
   *
   * Public — mirrors `feed`'s exposure (comments on a public feed post are
   * themselves public, including on the public share page). NOT_FOUND when
   * the post is missing/invisible. Filters out comments by deactivated
   * authors and (when the caller is authenticated) comments by anyone
   * blocked-either-direction with the caller — but NEVER filters a comment
   * solely because `deleted` is true; a soft-deleted comment still holds its
   * position in the thread, rendered as `deleted: true` / `body: ""`.
   */
  listComments: publicProcedure
    .input(listGardenCommentsInput)
    .output(listGardenCommentsOutput)
    .query(async ({ input, ctx }) => {
      await resolveVisibleGardenPost(ctx.db, input.postId);

      let cursorCreatedAt: Date | null = null;
      let cursorId: string | null = null;
      if (input.cursor) {
        const decoded = decodeKeysetCursor(input.cursor);
        cursorCreatedAt = decoded.createdAt;
        cursorId = decoded.id;
      }

      const callerId = ctx.user?.id ?? null;
      const blockedIds = callerId ? await blockedEitherDirectionUserIds(ctx.db, callerId) : [];

      const conditions = [eq(gardenPostComments.postId, input.postId), isNull(users.deactivatedAt)];
      if (cursorCreatedAt !== null && cursorId !== null) {
        conditions.push(
          or(
            lt(gardenPostComments.createdAt, cursorCreatedAt),
            and(
              eq(gardenPostComments.createdAt, cursorCreatedAt),
              lt(gardenPostComments.id, cursorId),
            ),
          )!,
        );
      }
      if (blockedIds.length > 0) {
        conditions.push(notInArray(gardenPostComments.userId, blockedIds));
      }

      const rows = await ctx.db
        .select({
          id: gardenPostComments.id,
          postId: gardenPostComments.postId,
          userId: gardenPostComments.userId,
          username: users.username,
          body: gardenPostComments.body,
          deleted: gardenPostComments.deleted,
          createdAt: gardenPostComments.createdAt,
        })
        .from(gardenPostComments)
        .innerJoin(users, eq(users.id, gardenPostComments.userId))
        .where(and(...conditions))
        .orderBy(desc(gardenPostComments.createdAt), desc(gardenPostComments.id))
        .limit(input.limit + 1);

      let nextCursor: string | null = null;
      if (rows.length > input.limit) {
        const lastRow = rows[input.limit - 1]!;
        nextCursor = encodeKeysetCursor(toDate(lastRow.createdAt ?? new Date()), lastRow.id);
      }

      const comments = rows.slice(0, input.limit).map(toGardenCommentDto);

      return { comments, nextCursor };
    }),

  /**
   * Soft-delete a comment (authed, author-only). UNAUTHORIZED for a
   * deactivated caller (`assertCallerActive`, called first). NOT_FOUND when
   * the comment doesn't exist or belongs to someone else (existence isn't
   * leaked to a non-author). `body` is kept in the row for report integrity —
   * only the `deleted` flag flips; idempotent (deleting an already-deleted
   * comment is a silent no-op).
   */
  deleteComment: protectedProcedure
    .input(deleteGardenCommentInput)
    .output(z.object({ success: z.literal(true) }))
    .mutation(async ({ input, ctx }) => {
      await assertCallerActive(ctx.db, ctx.user.id);

      const [row] = await ctx.db
        .select({ id: gardenPostComments.id, userId: gardenPostComments.userId })
        .from(gardenPostComments)
        .where(eq(gardenPostComments.id, input.commentId))
        .limit(1);

      if (!row || row.userId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
      }

      await ctx.db
        .update(gardenPostComments)
        .set({ deleted: true })
        .where(eq(gardenPostComments.id, input.commentId));

      return { success: true };
    }),

  /**
   * Report a comment (App Store Guideline 1.2 UGC moderation; authed).
   * UNAUTHORIZED for a deactivated caller (`assertCallerActive`, called
   * first). Mirrors chat.ts's `reportMessage`: NOT_FOUND when the comment
   * doesn't exist (never leaks whether it's missing vs. just not visible to
   * the reporter); TOO_MANY_REQUESTS past 10 reports/hour per reporter.
   */
  reportComment: protectedProcedure
    .input(reportGardenCommentInput)
    .output(z.object({ success: z.literal(true) }))
    .mutation(async ({ input, ctx }) => {
      await assertCallerActive(ctx.db, ctx.user.id);

      const [comment] = await ctx.db
        .select({ id: gardenPostComments.id })
        .from(gardenPostComments)
        .where(eq(gardenPostComments.id, input.commentId))
        .limit(1);

      if (!comment) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
      }

      await assertGardenCommentReportRateLimit(ctx.db, ctx.user.id);

      await ctx.db.insert(gardenCommentReports).values({
        commentId: input.commentId,
        reporterUserId: ctx.user.id,
        reason: input.reason,
      });

      return { success: true };
    }),
});
