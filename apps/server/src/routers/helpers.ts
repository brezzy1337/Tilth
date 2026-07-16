/**
 * Shared router helpers — tiny utilities used by multiple routers.
 *
 * Rules that must hold here:
 *   - No imports of env or any module with side-effects.
 *   - All deps (db, userId) are passed as parameters — never read from globals.
 *   - Never log secrets or user-identifying data.
 */

import { TRPCError } from "@trpc/server";
import { and, count, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Db, PushClient } from "../context";
import type { DbOrTx } from "../db/order-transitions";
import {
  stores,
  sourcingRequests,
  communityPlaces,
  conversations,
  pushTokens,
  users,
  userBlocks,
} from "../db/schema";
import type { SourcingRequest, SourcingRequestDirection, SourcingRequestStatus } from "@homegrown/shared";

// ---------------------------------------------------------------------------
// PostGIS radius idiom — the ONE ST_MakePoint/ST_DWithin/ST_Distance shape
// shared by listings.nearby, garden.feed, and places.nearby. All geo queries
// go through PostGIS (geography types), never app-side haversine math.
// ---------------------------------------------------------------------------

/**
 * Build the shared "within radius of (lat, lng)" SQL fragments around a
 * single ST_MakePoint anchor.
 *
 * - `point` — the `ST_MakePoint(lng, lat)::geography` anchor itself.
 * - `withinClause(geogColumn)` — `ST_DWithin(geogColumn, point, radiusM)`,
 *   for the WHERE clause (index-assisted radius filter).
 * - `distanceExpr(geogColumn)` — `ST_Distance(geogColumn, point)`, in metres,
 *   for SELECT (`AS distance_m`) and ORDER BY.
 *
 * `geogColumn` is a caller-supplied fragment naming the geography column in
 * that query's FROM aliases (e.g. sql`loc.geog`, sql`cp.location`). lat, lng,
 * and the radius are bound parameters — never interpolate user input into the
 * column fragment.
 */
export function geoRadius(
  lat: number,
  lng: number,
  radiusKm: number,
): {
  point: SQL;
  withinClause: (geogColumn: SQL) => SQL;
  distanceExpr: (geogColumn: SQL) => SQL;
} {
  const radiusMeters = radiusKm * 1000;
  const point = sql`ST_MakePoint(${lng}, ${lat})::geography`;
  return {
    point,
    withinClause: (geogColumn: SQL) => sql`ST_DWithin(${geogColumn}, ${point}, ${radiusMeters})`,
    distanceExpr: (geogColumn: SQL) => sql`ST_Distance(${geogColumn}, ${point})`,
  };
}

// ---------------------------------------------------------------------------
// Keyset cursor codec — the ONE base64 "<dateISO>|<uuid>" cursor convention
// shared by garden.feed, orders.listForMyStore, and the chat router. The
// *Parts variants are the core; chat's nullable-lastMessageAt conversations
// cursor wraps them with an empty-string sentinel for null.
// ---------------------------------------------------------------------------

/**
 * Encode raw (dateStr, id) parts as an opaque base64 cursor string.
 * The payload is always ASCII (ISO date — or a sentinel — plus a UUID), so
 * btoa is safe. Prefer `encodeKeysetCursor` unless the date can be a sentinel.
 */
export function encodeKeysetCursorParts(dateStr: string, id: string): string {
  return btoa(`${dateStr}|${id}`);
}

/**
 * Decode an opaque cursor back to its raw (dateStr, id) parts.
 * Validates base64, the "|" separator, and that `id` is a UUID — but leaves
 * date interpretation to the caller (chat's conversations cursor allows an
 * empty-string sentinel). Throws TRPCError BAD_REQUEST "Invalid cursor" on
 * any malformed part.
 */
export function decodeKeysetCursorParts(raw: string): { dateStr: string; id: string } {
  try {
    const decoded = atob(raw);
    const sepIdx = decoded.indexOf("|");
    if (sepIdx === -1) throw new Error("missing separator");
    const dateStr = decoded.slice(0, sepIdx);
    const id = decoded.slice(sepIdx + 1);
    z.string().uuid().parse(id);
    return { dateStr, id };
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
}

/** Encode a non-null (createdAt, id) pair as an opaque base64 cursor string. */
export function encodeKeysetCursor(createdAt: Date, id: string): string {
  return encodeKeysetCursorParts(createdAt.toISOString(), id);
}

/**
 * Decode an opaque cursor back to a non-null (createdAt, id) pair.
 * Throws TRPCError BAD_REQUEST "Invalid cursor" on any malformed part
 * (bad base64, missing separator, unparsable date, non-UUID id).
 */
export function decodeKeysetCursor(raw: string): { createdAt: Date; id: string } {
  const { dateStr, id } = decodeKeysetCursorParts(raw);
  const parsedDate = new Date(dateStr);
  if (isNaN(parsedDate.getTime())) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
  return { createdAt: parsedDate, id };
}

/**
 * Resolve the store that belongs to `userId`.
 *
 * Returns `{ id: string, name: string }` if found, or throws a NOT_FOUND
 * TRPCError with the canonical "You do not have a store. Create one first."
 * message — the ONE place that message string lives.
 *
 * Delegates to `resolveCallerStoreWithConnect` so the SELECT + NOT_FOUND
 * logic lives in exactly one place.
 */
export async function resolveCallerStore(db: Db, userId: string): Promise<{ id: string; name: string }> {
  const store = await resolveCallerStoreWithConnect(db, userId);
  return { id: store.id, name: store.name };
}

/**
 * Resolve the store that belongs to `userId`, including Stripe Connect fields.
 *
 * Used by the Connect onboarding router. Returns the full Connect state so the
 * router can check whether an account already exists before creating one.
 */
export async function resolveCallerStoreWithConnect(
  db: Db,
  userId: string,
): Promise<{
  id: string;
  name: string;
  stripeConnectAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}> {
  const [store] = await db
    .select({
      id: stores.id,
      name: stores.name,
      stripeConnectAccountId: stores.stripeConnectAccountId,
      chargesEnabled: stores.chargesEnabled,
      payoutsEnabled: stores.payoutsEnabled,
      detailsSubmitted: stores.detailsSubmitted,
    })
    .from(stores)
    .where(eq(stores.userId, userId))
    .limit(1);

  if (!store) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "You do not have a store. Create one first.",
    });
  }

  return store;
}

// ---------------------------------------------------------------------------
// Sourcing (F-049) — the ONE `sourcing_requests` row -> `SourcingRequest` DTO
// mapping, and the ONE batch-load-by-id query, shared by chat.ts (which
// attaches a nullable `sourcingRequest` to each chat message) and
// sourcing.ts. Lives here — not in either router — because chat.ts and
// sourcing.ts each import the other's exported rate-limit/block/truncate
// helpers would create a cycle; both already depend on this file.
// ---------------------------------------------------------------------------

/** The shape needed to build a `SourcingRequest` DTO — a superset is fine (structural typing). */
export interface SourcingRequestFullRow {
  id: string;
  direction: string;
  status: string;
  placeId: string;
  placeName: string;
  storeId: string;
  storeName: string;
  conversationId: string;
  produce: string;
  quantity: string;
  neededBy: string | null;
  note: string | null;
  createdByUserId: string;
  respondedAt: Date | null;
  createdAt: Date | null;
}

/** Map a joined `sourcing_requests` row (+ place/store names) to the shared `SourcingRequest` DTO. */
export function toSourcingRequestDto(row: SourcingRequestFullRow): SourcingRequest {
  return {
    id: row.id,
    direction: row.direction as SourcingRequestDirection,
    status: row.status as SourcingRequestStatus,
    placeId: row.placeId,
    placeName: row.placeName,
    storeId: row.storeId,
    storeName: row.storeName,
    conversationId: row.conversationId,
    produce: row.produce,
    quantity: row.quantity,
    neededBy: row.neededBy,
    note: row.note,
    createdByUserId: row.createdByUserId,
    respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
  };
}

/**
 * Batch-load sourcing requests by id (joined to place/store names) as a
 * `Map<id, SourcingRequest>` — used by `chat.messages` to attach the request
 * card to its originating message without an N+1 query per page.
 */
export async function loadSourcingRequestsByIds(
  db: Db,
  ids: string[],
): Promise<Map<string, SourcingRequest>> {
  const map = new Map<string, SourcingRequest>();
  if (ids.length === 0) return map;

  const rows = await db
    .select({
      id: sourcingRequests.id,
      direction: sourcingRequests.direction,
      status: sourcingRequests.status,
      placeId: sourcingRequests.placeId,
      placeName: communityPlaces.name,
      storeId: sourcingRequests.storeId,
      storeName: stores.name,
      conversationId: sourcingRequests.conversationId,
      produce: sourcingRequests.produce,
      quantity: sourcingRequests.quantity,
      neededBy: sourcingRequests.neededBy,
      note: sourcingRequests.note,
      createdByUserId: sourcingRequests.createdByUserId,
      respondedAt: sourcingRequests.respondedAt,
      createdAt: sourcingRequests.createdAt,
    })
    .from(sourcingRequests)
    .innerJoin(communityPlaces, eq(communityPlaces.id, sourcingRequests.placeId))
    .innerJoin(stores, eq(stores.id, sourcingRequests.storeId))
    .where(inArray(sourcingRequests.id, ids));

  for (const row of rows) map.set(row.id, toSourcingRequestDto(row));
  return map;
}

/**
 * Resolve the approved community place linked to `userId` — the superset row
 * shape (`{id, name, type, address}`) needed by both `places.mine` and
 * sourcing's `resolveCallerPlace`. Returns `null` (never throws) when the
 * caller has no linked approved place; callers that need a thrown NOT_FOUND
 * (sourcing) wrap this, callers that treat "no place" as a valid null result
 * (places.mine) call it directly.
 */
export async function findLinkedApprovedPlace(
  db: Db,
  userId: string,
): Promise<{ id: string; name: string; type: string; address: string | null } | null> {
  const [place] = await db
    .select({
      id: communityPlaces.id,
      name: communityPlaces.name,
      type: communityPlaces.type,
      address: communityPlaces.address,
    })
    .from(communityPlaces)
    .where(and(eq(communityPlaces.linkedUserId, userId), eq(communityPlaces.status, "approved")))
    .limit(1);

  return place ?? null;
}

// ---------------------------------------------------------------------------
// Blocks — the ONE either-direction block check, shared by chat.ts (start/
// send), sourcing.ts (createRequest/createOffer), and garden.ts
// (createComment). Moved here from chat.ts once a third router needed it —
// cross-router shared, like pushToUser/assertCallerActive above.
// ---------------------------------------------------------------------------

/** Whether `a` and `b` block each other in either direction. */
export async function isBlockedEitherDirection(db: Db, a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ blockerUserId: userBlocks.blockerUserId })
    .from(userBlocks)
    .where(
      or(
        and(eq(userBlocks.blockerUserId, a), eq(userBlocks.blockedUserId, b)),
        and(eq(userBlocks.blockerUserId, b), eq(userBlocks.blockedUserId, a)),
      ),
    )
    .limit(1);
  return !!row;
}

// ---------------------------------------------------------------------------
// Rate limiting — the ONE DB-count-based limiter shape shared by chat.ts's
// `assertSendRateLimit`/`assertReportRateLimit` and garden.ts's
// `assertGardenCommentRateLimit`/`assertGardenCommentReportRateLimit` (all
// four were near-identical hand-rolled "COUNT rows for this user within the
// window" checks — now thin wrappers over this). Pilot-appropriate (no Redis
// / extra infra): a COUNT over an indexed (user, created_at) range is plenty
// at this volume. NOT used by chat.ts's `assertPushTokenRateLimit`, which
// counts by `updatedAt` (re-registrations moving an existing token), not
// `createdAt` — a genuinely different shape, not a fifth copy of this one.
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  /** The table to count rows in (e.g. `messages`, `gardenPostComments`). */
  table: AnyPgTable;
  /** The column holding the acting/reporting user's id (e.g. `messages.senderUserId`). */
  userIdColumn: AnyPgColumn;
  /** The column holding the row's timestamp (e.g. `messages.createdAt`). */
  createdAtColumn: AnyPgColumn;
  /** The user id to count rows for. */
  userId: string;
  /** Max rows allowed within `windowMs` — the limit is hit AT this count (>=), not just past it. */
  max: number;
  /** The rolling window, in milliseconds. */
  windowMs: number;
  /** TOO_MANY_REQUESTS message shown to the caller once the limit is hit. */
  message: string;
}

/**
 * Throw TOO_MANY_REQUESTS when `userId` has `max` or more rows in `table`
 * (matched via `userIdColumn`) with `createdAtColumn` within the last
 * `windowMs`. See the module-header note above for which callers use this.
 */
export async function assertRateLimit(db: Db, opts: RateLimitOptions): Promise<void> {
  const since = new Date(Date.now() - opts.windowMs);
  const [row] = await db
    .select({ count: count() })
    .from(opts.table)
    .where(and(eq(opts.userIdColumn, opts.userId), gte(opts.createdAtColumn, since)));

  if ((row?.count ?? 0) >= opts.max) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: opts.message });
  }
}

// ---------------------------------------------------------------------------
// Conversation upsert — the ONE (buyer_id, store_id) insert…onConflictDoUpdate
// idiom shared by chat.start and both sourcing create mutations.
// ---------------------------------------------------------------------------

/**
 * Upsert the (buyer, store) conversation and return its id — idempotent per
 * (buyer_id, store_id): if one is already open, its existing id comes back
 * unchanged. Accepts a `Db` or an open transaction handle (`DbOrTx`) so
 * callers that need the insert to participate in a larger transaction (the
 * sourcing create mutations) and callers that don't (chat.start) share the
 * same helper.
 *
 * Throws INTERNAL_SERVER_ERROR ("Failed to start conversation") if the
 * upsert unexpectedly returns no row.
 */
export async function upsertConversation(dbOrTx: DbOrTx, buyerId: string, storeId: string): Promise<string> {
  const [row] = await dbOrTx
    .insert(conversations)
    .values({ buyerId, storeId })
    .onConflictDoUpdate({
      target: [conversations.buyerId, conversations.storeId],
      // No-op update (buyer_id = its own excluded value) — required by
      // Postgres upsert syntax to RETURNING the existing row on conflict.
      set: { buyerId: sql`excluded.buyer_id` },
    })
    .returning({ id: conversations.id });

  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to start conversation",
    });
  }

  return row.id;
}

// ---------------------------------------------------------------------------
// Push-after-commit — the ONE "look up tokens, truncate, send, swallow errors"
// idiom shared by chat.send and the sourcing router's create/respond/withdraw
// mutations.
// ---------------------------------------------------------------------------

/** Push notification body is truncated to this length (mirrors chat.ts's PUSH_BODY_MAX_CHARS). */
const PUSH_BODY_MAX_CHARS = 100;

/**
 * Best-effort push to `userId`'s registered devices, AFTER the caller's
 * transaction has committed. Never throws — mirrors chat.send's push step
 * (AWAITED on purpose: on Cloud Run, minScale 0 + CPU throttled outside
 * requests means a fire-and-forget promise can be starved or reclaimed once
 * the response flushes, silently dropping the notification). `body` is
 * truncated to PUSH_BODY_MAX_CHARS before sending.
 */
export async function pushToUser(
  db: Db,
  push: PushClient,
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    const tokens = await db
      .select({ token: pushTokens.token })
      .from(pushTokens)
      .where(eq(pushTokens.userId, userId));

    if (tokens.length > 0) {
      await push.send({
        tokens: tokens.map((t) => t.token),
        title,
        body: body.length > PUSH_BODY_MAX_CHARS ? `${body.slice(0, PUSH_BODY_MAX_CHARS)}…` : body,
        data,
      });
    }
  } catch (err) {
    // Never let a push-path failure escape and affect the caller — the
    // triggering write is already committed.
    console.error("[push] notification failed", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Deactivation (F-051) — TWO directions of coverage around a deactivated
// account, both driven off the same `users.deactivatedAt` column (set by
// `auth.deleteAccount`, soft-delete + 30-day grace; cleared by a
// self-restoring `auth.login` within the grace window):
//
//   1. COUNTERPARTY direction — hides a deactivated seller/place owner from
//      public discovery (`listings.nearby`, `sourcing.growers`, `garden.feed`,
//      `places.nearby`'s `acceptsOffers`) and gates writes that would notify
//      them (`stores.get` / `chat.start` via `resolveActiveStore`, `chat.send`,
//      `sourcing.createRequest`/`createOffer`/`respond`).
//   2. CALLER direction — refuses a write attempted BY a deactivated account
//      (`assertCallerActive`, called at the top of: `orders.create`,
//      `chat.start`/`send`, `sourcing.createRequest`/`createOffer`/`respond`/
//      `withdraw`, `garden.createPhotoSet`/`createPhotoUploadUrls`/`createVideo`,
//      `garden.toggleLike`/`createComment`/`deleteComment`/`reportComment`).
//      A deactivated caller reading/browsing is NOT blocked — only writes are.
// ---------------------------------------------------------------------------

/**
 * Raw-SQL predicate: "the joined `users` alias is not deactivated". For
 * hand-written `db.execute(sql\`…\`)` queries that already JOIN (or LEFT
 * JOIN) a `users` row for the seller/store-owner/linked-buyer in question.
 * `usersAlias` names that alias in the query's FROM/JOIN clauses (e.g.
 * `sql\`u\``) — never interpolate anything but a fixed alias fragment here.
 */
export function activeUserClause(usersAlias: SQL): SQL {
  return sql`${usersAlias}.deactivated_at IS NULL`;
}

/**
 * Query-builder check: is `userId` currently deactivated? For procedures
 * that resolve a single target user id via the query builder rather than a
 * raw-SQL join (`chat.start`/`send`, `sourcing.createRequest`/`createOffer`/
 * `respond`) — one lookup instead of six hand-rolled `deactivatedAt IS NOT
 * NULL` checks.
 */
export async function isUserDeactivated(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.deactivatedAt != null;
}

/**
 * Throw UNAUTHORIZED (generic message — does not reveal WHY) when the CALLER
 * (`userId`, always `ctx.user.id` — never a counterparty) is deactivated. Thin
 * wrapper over `isUserDeactivated` for the write endpoints listed in the
 * module-header comment above; call this FIRST, before any other authz/state
 * check, so a deactivated caller never observes a different error shape than
 * an active one for the same otherwise-invalid request.
 */
export async function assertCallerActive(db: Db, userId: string): Promise<void> {
  if (await isUserDeactivated(db, userId)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "This account is no longer active" });
  }
}

/**
 * Resolve a store by id, hiding a store whose owner has deactivated their
 * account behind the SAME NOT_FOUND as a nonexistent store — the ONE
 * stores⋈users + `ownerDeactivatedAt` + NOT_FOUND join previously hand-
 * assembled identically by `stores.get` and `chat.start`. Single round-trip
 * (the join lives inside this helper); preserves the exact "Store not found"
 * message both callers already used.
 */
export async function resolveActiveStore(
  db: Db,
  storeId: string,
): Promise<{ id: string; userId: string; name: string; logo: string | null; about: string | null }> {
  const [row] = await db
    .select({
      id: stores.id,
      userId: stores.userId,
      name: stores.name,
      logo: stores.logo,
      about: stores.about,
      // Not returned — used only to hide a deactivated owner's store behind
      // the same NOT_FOUND as a nonexistent one.
      ownerDeactivatedAt: users.deactivatedAt,
    })
    .from(stores)
    .innerJoin(users, eq(users.id, stores.userId))
    .where(eq(stores.id, storeId))
    .limit(1);

  if (!row || row.ownerDeactivatedAt) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Store not found" });
  }

  return { id: row.id, userId: row.userId, name: row.name, logo: row.logo, about: row.about };
}
