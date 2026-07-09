/**
 * Sourcing router — F-049 structured produce requests/offers between
 * community places (co-ops/farmers markets) and growers (stores).
 *
 * A "sourcing request" rides the existing chat (see chat.ts): the
 * originating message carries `sourcingRequestId` (the "card"); the
 * counterparty accepts/declines, or the creator withdraws, and each of those
 * appends a plain-text follow-up message (no id — exactly one card per
 * request). Two directions are first-class:
 *   - `place_to_grower` — a community place (co-op/market) asks a grower to
 *     supply produce (`createRequest`).
 *   - `grower_to_place` — a grower offers to supply a place (`createOffer`).
 *
 * `createRequest`/`createOffer` — protected; upserts the (buyer, store)
 *   conversation, inserts the sourcing_requests row + its originating
 *   message, bumps `last_message_at`, and pushes to the OTHER party after
 *   the transaction commits (awaited — see chat.ts's Cloud Run rationale).
 * `respond`      — protected; COUNTERPARTY-only, pending-only. Flips status,
 *   appends a plain follow-up message, pushes the creator after commit.
 * `withdraw`     — protected; CREATOR-only, pending-only. Same shape as `respond`.
 * `listMine`     — protected; the caller's requests/offers (as place buyer OR
 *   store owner), newest first, capped at 50 (no cursor — pilot scale).
 * `growers`      — protected, place-linked callers only; PostGIS-nearby
 *   stores with a per-store listing count + up to 3 sample listing names.
 *
 * Rules that must hold here:
 *   - No imports of env, db/index, or SDKs — everything via ctx.
 *   - Participant/authz checks that fail surface NOT_FOUND (never FORBIDDEN —
 *     don't leak whether a request/place/store exists to a non-participant).
 *   - State conflicts (responding/withdrawing a non-pending request) surface
 *     BAD_REQUEST, matching orders.ts's guarded-UPDATE convention.
 *   - Geo (`growers`) goes through PostGIS ST_DWithin/ST_Distance — never
 *     app-side haversine math.
 *   - Reuses chat.ts's `isBlockedEitherDirection` / `assertSendRateLimit` /
 *     `truncate` rather than duplicating them.
 *   - Message-body summaries may say "fulfillment request" (user-facing
 *     copy) — no *code identifier* here uses that word.
 */

import { TRPCError } from "@trpc/server";
import { eq, and, or, desc, sql } from "drizzle-orm";
import {
  createSourcingRequestInput,
  createSourcingOfferInput,
  respondSourcingRequestInput,
  withdrawSourcingRequestInput,
  sourcingRequest as sourcingRequestSchema,
  createSourcingRequestOutput,
  sourcingListMineOutput,
  sourcingGrowersOutput,
  nearbyInput,
  type SourcingRequest,
} from "@homegrown/shared";
import { protectedProcedure, router } from "../trpc";
import {
  sourcingRequests,
  communityPlaces,
  stores,
  conversations,
  messages,
  pushTokens,
} from "../db/schema";
import { geoRadius, toSourcingRequestDto, type SourcingRequestFullRow } from "./helpers";
import { isBlockedEitherDirection, assertSendRateLimit, truncate } from "./chat";
import type { Db, PushClient } from "../context";

/** Push notification body is truncated to this length (mirrors chat.ts). */
const PUSH_BODY_MAX_CHARS = 100;

/** Columns returned by every sourcing_requests insert/update `.returning()`. */
const sourcingRequestCols = {
  id: sourcingRequests.id,
  direction: sourcingRequests.direction,
  status: sourcingRequests.status,
  placeId: sourcingRequests.placeId,
  storeId: sourcingRequests.storeId,
  conversationId: sourcingRequests.conversationId,
  produce: sourcingRequests.produce,
  quantity: sourcingRequests.quantity,
  neededBy: sourcingRequests.neededBy,
  note: sourcingRequests.note,
  createdByUserId: sourcingRequests.createdByUserId,
  respondedAt: sourcingRequests.respondedAt,
  createdAt: sourcingRequests.createdAt,
  updatedAt: sourcingRequests.updatedAt,
} as const;

// ---------------------------------------------------------------------------
// Message-body summary formatters — exported for unit testing.
// ---------------------------------------------------------------------------

function summarize(quantity: string, produce: string, neededBy: string | null, dateVerb: string): string {
  const base = `${quantity} of ${produce}`;
  return neededBy ? `${base} — ${dateVerb} ${neededBy}` : base;
}

/** Originating message body for `createRequest` (place -> grower). */
export function buildCreateRequestBody(quantity: string, produce: string, neededBy: string | null): string {
  return `Fulfillment request: ${summarize(quantity, produce, neededBy, "needed by")}`;
}

/** Originating message body for `createOffer` (grower -> place). */
export function buildCreateOfferBody(quantity: string, produce: string, neededBy: string | null): string {
  return `Offer to supply: ${summarize(quantity, produce, neededBy, "available by")}`;
}

/** Follow-up message body for `respond`. */
export function buildRespondBody(
  response: "accepted" | "declined",
  quantity: string,
  produce: string,
): string {
  const verb = response === "accepted" ? "Accepted" : "Declined";
  return `${verb} the fulfillment request: ${quantity} of ${produce}`;
}

/** Follow-up message body for `withdraw`. */
export function buildWithdrawBody(quantity: string, produce: string): string {
  return `Withdrew the fulfillment request: ${quantity} of ${produce}`;
}

// ---------------------------------------------------------------------------
// Caller-place resolution — the operator-invited place account (see
// scripts/link-place-buyer.ts). Exported for testing.
// ---------------------------------------------------------------------------

/**
 * Resolve the approved community place linked to `userId`. Throws NOT_FOUND
 * ("no linked place") when the caller has no linked place — the same message
 * regardless of "never linked" vs "linked to a pending/rejected place", so a
 * prober can't distinguish the two.
 */
export async function resolveCallerPlace(db: Db, userId: string): Promise<{ id: string; name: string }> {
  const [place] = await db
    .select({ id: communityPlaces.id, name: communityPlaces.name })
    .from(communityPlaces)
    .where(and(eq(communityPlaces.linkedUserId, userId), eq(communityPlaces.status, "approved")))
    .limit(1);

  if (!place) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No linked community place for this account" });
  }

  return place;
}

// ---------------------------------------------------------------------------
// Full-row load — sourcing_requests joined to place/store identity +
// authorization fields (linkedUserId / store owner userId), used by
// respond/withdraw. Distinct from helpers.ts's SourcingRequestFullRow (which
// omits these authz-only fields) — this is a strict superset, so
// `toSourcingRequestDto` accepts it structurally.
// ---------------------------------------------------------------------------

interface SourcingRequestAuthRow extends SourcingRequestFullRow {
  placeLinkedUserId: string | null;
  storeUserId: string;
}

async function loadSourcingRequestFull(
  db: Db,
  requestId: string,
): Promise<SourcingRequestAuthRow | undefined> {
  const [row] = await db
    .select({
      id: sourcingRequests.id,
      direction: sourcingRequests.direction,
      status: sourcingRequests.status,
      placeId: sourcingRequests.placeId,
      placeName: communityPlaces.name,
      placeLinkedUserId: communityPlaces.linkedUserId,
      storeId: sourcingRequests.storeId,
      storeName: stores.name,
      storeUserId: stores.userId,
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
    .where(eq(sourcingRequests.id, requestId))
    .limit(1);

  return row;
}

/** The user id of the "other side" of a sourcing request, by direction. */
function counterpartyUserId(row: SourcingRequestAuthRow): string | null {
  return row.direction === "place_to_grower" ? row.storeUserId : row.placeLinkedUserId;
}

/** The user id of the creator's "identity" side, for push titles. */
function creatorDisplayName(row: SourcingRequestAuthRow): string {
  return row.direction === "place_to_grower" ? row.placeName : row.storeName;
}

/** The user id of the counterparty's "identity" side, for push titles. */
function counterpartyDisplayName(row: SourcingRequestAuthRow): string {
  return row.direction === "place_to_grower" ? row.storeName : row.placeName;
}

/**
 * Best-effort push to `userId`'s registered devices, AFTER the caller's
 * transaction has committed. Never throws — mirrors chat.send's push step
 * (awaited on purpose: Cloud Run minScale-0 can starve a fire-and-forget
 * promise after the response flushes).
 */
async function pushAfterCommit(
  db: Db,
  push: PushClient,
  userId: string,
  title: string,
  body: string,
  conversationId: string,
): Promise<void> {
  try {
    const tokens = await db.select({ token: pushTokens.token }).from(pushTokens).where(eq(pushTokens.userId, userId));
    if (tokens.length > 0) {
      await push.send({
        tokens: tokens.map((t) => t.token),
        title,
        body: truncate(body, PUSH_BODY_MAX_CHARS),
        data: { conversationId },
      });
    }
  } catch (err) {
    console.error(
      "[sourcing] push notification failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

export const sourcingRouter = router({
  /**
   * A community place asks a grower to supply produce (place -> grower).
   * Caller must be the linked buyer of an approved place. Rejects the
   * caller's own store, blocked pairs, and rate-limits like chat.send.
   */
  createRequest: protectedProcedure
    .input(createSourcingRequestInput)
    .output(createSourcingRequestOutput)
    .mutation(async ({ input, ctx }) => {
      const place = await resolveCallerPlace(ctx.db, ctx.user.id);

      const [targetStore] = await ctx.db
        .select({ id: stores.id, userId: stores.userId, name: stores.name })
        .from(stores)
        .where(eq(stores.id, input.storeId))
        .limit(1);

      if (!targetStore) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Store not found" });
      }

      if (targetStore.userId === ctx.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You can't send a sourcing request to your own store",
        });
      }

      if (await isBlockedEitherDirection(ctx.db, ctx.user.id, targetStore.userId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can't send a sourcing request to this store",
        });
      }

      await assertSendRateLimit(ctx.db, ctx.user.id);

      const neededBy = input.neededBy ?? null;
      const note = input.note ?? null;
      const body = buildCreateRequestBody(input.quantity, input.produce, neededBy);

      const { requestRow, conversationId } = await ctx.db.transaction(async (tx) => {
        const [convRow] = await tx
          .insert(conversations)
          .values({ buyerId: ctx.user.id, storeId: targetStore.id })
          .onConflictDoUpdate({
            target: [conversations.buyerId, conversations.storeId],
            // No-op update (same shape as chat.start) — required by Postgres
            // upsert syntax to RETURNING the existing row on conflict.
            set: { buyerId: sql`excluded.buyer_id` },
          })
          .returning({ id: conversations.id });

        if (!convRow) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to start conversation",
          });
        }
        const conversationId = convRow.id;

        const [reqRow] = await tx
          .insert(sourcingRequests)
          .values({
            direction: "place_to_grower",
            placeId: place.id,
            storeId: targetStore.id,
            conversationId,
            produce: input.produce,
            quantity: input.quantity,
            neededBy,
            note,
            createdByUserId: ctx.user.id,
          })
          .returning(sourcingRequestCols);

        if (!reqRow) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create sourcing request",
          });
        }

        const [msgRow] = await tx
          .insert(messages)
          .values({
            conversationId,
            senderUserId: ctx.user.id,
            body,
            sourcingRequestId: reqRow.id,
          })
          .returning({ createdAt: messages.createdAt });

        await tx
          .update(conversations)
          .set({ lastMessageAt: msgRow?.createdAt ?? new Date() })
          .where(eq(conversations.id, conversationId));

        return { requestRow: reqRow, conversationId };
      });

      await pushAfterCommit(ctx.db, ctx.push, targetStore.userId, place.name, body, conversationId);

      return {
        request: toSourcingRequestDto({ ...requestRow, placeName: place.name, storeName: targetStore.name }),
        conversationId,
      };
    }),

  /**
   * A grower offers to supply a place (grower -> place). Caller must own a
   * store. Target place must be approved AND have a linked buyer account
   * (gates the mobile "Offer to supply" CTA — offering to a place with no
   * linked account has no one to notify).
   */
  createOffer: protectedProcedure
    .input(createSourcingOfferInput)
    .output(createSourcingRequestOutput)
    .mutation(async ({ input, ctx }) => {
      const [callerStore] = await ctx.db
        .select({ id: stores.id, name: stores.name })
        .from(stores)
        .where(eq(stores.userId, ctx.user.id))
        .limit(1);

      if (!callerStore) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "You do not have a store. Create one first.",
        });
      }

      const [targetPlace] = await ctx.db
        .select({
          id: communityPlaces.id,
          name: communityPlaces.name,
          status: communityPlaces.status,
          linkedUserId: communityPlaces.linkedUserId,
        })
        .from(communityPlaces)
        .where(eq(communityPlaces.id, input.placeId))
        .limit(1);

      if (!targetPlace || targetPlace.status !== "approved" || !targetPlace.linkedUserId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Place not found" });
      }
      const placeLinkedUserId = targetPlace.linkedUserId;

      if (await isBlockedEitherDirection(ctx.db, ctx.user.id, placeLinkedUserId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can't send an offer to this place",
        });
      }

      await assertSendRateLimit(ctx.db, ctx.user.id);

      const neededBy = input.neededBy ?? null;
      const note = input.note ?? null;
      const body = buildCreateOfferBody(input.quantity, input.produce, neededBy);

      const { requestRow, conversationId } = await ctx.db.transaction(async (tx) => {
        const [convRow] = await tx
          .insert(conversations)
          .values({ buyerId: placeLinkedUserId, storeId: callerStore.id })
          .onConflictDoUpdate({
            target: [conversations.buyerId, conversations.storeId],
            // No-op update (same shape as chat.start) — required by Postgres
            // upsert syntax to RETURNING the existing row on conflict.
            set: { buyerId: sql`excluded.buyer_id` },
          })
          .returning({ id: conversations.id });

        if (!convRow) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to start conversation",
          });
        }
        const conversationId = convRow.id;

        const [reqRow] = await tx
          .insert(sourcingRequests)
          .values({
            direction: "grower_to_place",
            placeId: targetPlace.id,
            storeId: callerStore.id,
            conversationId,
            produce: input.produce,
            quantity: input.quantity,
            neededBy,
            note,
            createdByUserId: ctx.user.id,
          })
          .returning(sourcingRequestCols);

        if (!reqRow) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create sourcing offer",
          });
        }

        const [msgRow] = await tx
          .insert(messages)
          .values({
            conversationId,
            senderUserId: ctx.user.id,
            body,
            sourcingRequestId: reqRow.id,
          })
          .returning({ createdAt: messages.createdAt });

        await tx
          .update(conversations)
          .set({ lastMessageAt: msgRow?.createdAt ?? new Date() })
          .where(eq(conversations.id, conversationId));

        return { requestRow: reqRow, conversationId };
      });

      await pushAfterCommit(ctx.db, ctx.push, placeLinkedUserId, callerStore.name, body, conversationId);

      return {
        request: toSourcingRequestDto({
          ...requestRow,
          placeName: targetPlace.name,
          storeName: callerStore.name,
        }),
        conversationId,
      };
    }),

  /**
   * The COUNTERPARTY accepts or declines a pending request/offer. The
   * creator (or anyone else) gets NOT_FOUND — existence isn't leaked, same
   * convention as chat.ts's `resolveParticipant`.
   */
  respond: protectedProcedure
    .input(respondSourcingRequestInput)
    .output(sourcingRequestSchema)
    .mutation(async ({ input, ctx }) => {
      const found = await loadSourcingRequestFull(ctx.db, input.requestId);
      if (!found || counterpartyUserId(found) !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Sourcing request not found" });
      }

      if (found.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This request is no longer pending" });
      }

      const now = new Date();
      const body = buildRespondBody(input.response, found.quantity, found.produce);

      const updated = await ctx.db.transaction(async (tx) => {
        const claimed = await tx
          .update(sourcingRequests)
          .set({ status: input.response, respondedAt: now, updatedAt: now })
          .where(and(eq(sourcingRequests.id, input.requestId), eq(sourcingRequests.status, "pending")))
          .returning(sourcingRequestCols);

        const row = claimed[0];
        if (!row) {
          // Status raced away between the pre-check read and the guarded UPDATE.
          throw new TRPCError({ code: "BAD_REQUEST", message: "This request is no longer pending" });
        }

        await tx.insert(messages).values({
          conversationId: found.conversationId,
          senderUserId: ctx.user.id,
          body,
        });

        await tx
          .update(conversations)
          .set({ lastMessageAt: now })
          .where(eq(conversations.id, found.conversationId));

        return row;
      });

      await pushAfterCommit(
        ctx.db,
        ctx.push,
        found.createdByUserId,
        counterpartyDisplayName(found),
        body,
        found.conversationId,
      );

      return toSourcingRequestDto({ ...updated, placeName: found.placeName, storeName: found.storeName });
    }),

  /**
   * The CREATOR withdraws a pending request/offer. Anyone else gets
   * NOT_FOUND (existence isn't leaked).
   */
  withdraw: protectedProcedure
    .input(withdrawSourcingRequestInput)
    .output(sourcingRequestSchema)
    .mutation(async ({ input, ctx }) => {
      const found = await loadSourcingRequestFull(ctx.db, input.requestId);
      if (!found || found.createdByUserId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Sourcing request not found" });
      }

      if (found.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This request is no longer pending" });
      }

      const now = new Date();
      const body = buildWithdrawBody(found.quantity, found.produce);

      const updated = await ctx.db.transaction(async (tx) => {
        const claimed = await tx
          .update(sourcingRequests)
          .set({ status: "withdrawn", updatedAt: now })
          .where(and(eq(sourcingRequests.id, input.requestId), eq(sourcingRequests.status, "pending")))
          .returning(sourcingRequestCols);

        const row = claimed[0];
        if (!row) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This request is no longer pending" });
        }

        await tx.insert(messages).values({
          conversationId: found.conversationId,
          senderUserId: ctx.user.id,
          body,
        });

        await tx
          .update(conversations)
          .set({ lastMessageAt: now })
          .where(eq(conversations.id, found.conversationId));

        return row;
      });

      const counterparty = counterpartyUserId(found);
      if (counterparty) {
        await pushAfterCommit(
          ctx.db,
          ctx.push,
          counterparty,
          creatorDisplayName(found),
          body,
          found.conversationId,
        );
      }

      return toSourcingRequestDto({ ...updated, placeName: found.placeName, storeName: found.storeName });
    }),

  /**
   * The caller's requests/offers — as a place buyer OR as a store owner —
   * newest first. Capped at 50 (no cursor — pilot scale never approaches it).
   */
  listMine: protectedProcedure.output(sourcingListMineOutput).query(async ({ ctx }) => {
    const rows = await ctx.db
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
      .where(or(eq(communityPlaces.linkedUserId, ctx.user.id), eq(stores.userId, ctx.user.id)))
      .orderBy(desc(sourcingRequests.createdAt))
      .limit(50);

    const items: SourcingRequest[] = rows.map(toSourcingRequestDto);
    return items;
  }),

  /**
   * Browse growers (stores) near a lat/lng — the list a place-linked caller
   * uses to pick who to request produce from. Place-linked callers only
   * (NOT_FOUND otherwise). PostGIS ST_DWithin/ST_Distance, nearest-first,
   * capped at 30. Stores with zero listings ARE included (a grower may be
   * between harvests) — `listingCount: 0` is honest, not hidden.
   */
  growers: protectedProcedure
    .input(nearbyInput)
    .output(sourcingGrowersOutput)
    .query(async ({ input, ctx }) => {
      await resolveCallerPlace(ctx.db, ctx.user.id);

      const { lat, lng, radiusKm } = input;
      const geo = geoRadius(lat, lng, radiusKm);
      const geogColumn = sql`loc.geog`;

      type GrowerRow = {
        store_id: string;
        name: string;
        logo: string | null;
        distance_m: string | number;
        listing_count: string | number;
        sample_listings: string[] | null;
      };

      const rows = await ctx.db.execute(sql`
        SELECT
          s.id AS store_id,
          s.name,
          s.logo,
          ${geo.distanceExpr(geogColumn)} AS distance_m,
          COALESCE(lc.listing_count, 0) AS listing_count,
          COALESCE(sl.sample_names, ARRAY[]::text[]) AS sample_listings
        FROM stores s
        JOIN locations loc ON loc.store_id = s.id
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS listing_count FROM listings l WHERE l.store_id = s.id
        ) lc ON true
        LEFT JOIN LATERAL (
          SELECT array_agg(t.name ORDER BY t.created_at DESC) AS sample_names FROM (
            SELECT name, created_at FROM listings WHERE store_id = s.id ORDER BY created_at DESC LIMIT 3
          ) t
        ) sl ON true
        WHERE ${geo.withinClause(geogColumn)}
        ORDER BY ${geo.distanceExpr(geogColumn)} ASC
        LIMIT 30
      `);

      return rows.map((r) => {
        const row = r as GrowerRow;
        return {
          storeId: row.store_id,
          name: row.name,
          logo: row.logo,
          distanceKm: Number(row.distance_m) / 1000,
          listingCount: Number(row.listing_count),
          sampleListings: row.sample_listings ?? [],
        };
      });
    }),
});
