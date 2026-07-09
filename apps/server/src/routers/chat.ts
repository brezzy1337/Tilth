/**
 * Chat router — F-037/F-038 1:1 buyer<->store messaging (DIY, polling clients).
 *
 * `start`             — buyer-authed; idempotent upsert on (buyer_id, store_id).
 * `list`              — authed; the caller's inbox (as buyer OR as store owner),
 *                        most-recent-activity first, keyset cursor-paginated.
 * `messages`          — authed, participant-only; newest-first keyset pages.
 * `send`              — authed, participant-only; inserts a message, bumps
 *                        `last_message_at`, and sends a best-effort push
 *                        notification to the OTHER party after the write commits.
 * `markRead`          — authed, participant-only; marks the caller's side read.
 * `blockUser`         — authed; idempotent upsert (no error if repeated).
 * `reportMessage`     — authed, reporter must be a participant of the message's
 *                        conversation (App Store Guideline 1.2 UGC moderation).
 * `registerPushToken` — authed; upsert by token (re-registering moves ownership
 *                        to the new user — device changed accounts).
 *
 * Rules that must hold here:
 *   - No imports of env, db/index, or SDKs — everything via ctx (`ctx.push`).
 *   - Participant checks that fail must surface NOT_FOUND (never leak whether
 *     a conversation/message exists to a non-participant).
 *   - Block checks that fail must surface a generic FORBIDDEN message — never
 *     reveal WHO blocked whom.
 *   - Push failures must never fail the mutation — `ctx.push.send` already
 *     swallows its own errors (see push.ts), and the call site in `send`
 *     wraps the whole push step in its own try/catch. The push IS awaited,
 *     though: on Cloud Run (minScale 0, CPU throttled outside requests) a
 *     fire-and-forget promise can be starved or reclaimed after the response
 *     flushes, silently dropping notifications.
 *   - Write endpoints are rate-limited per user (pilot-appropriate, DB-count
 *     based — no extra infra): `send` 30 msgs/60s, `reportMessage` 10/hour,
 *     `registerPushToken` 10 distinct tokens/hour. Excess gets
 *     TOO_MANY_REQUESTS.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, and, or, lt, gte, desc, sql, count } from "drizzle-orm";
import {
  startConversationInput,
  startConversationOutput,
  conversationsListInput,
  conversationsListOutput,
  messagesListInput,
  messagesListOutput,
  sendMessageInput,
  chatMessage,
  markConversationReadInput,
  blockUserInput,
  reportMessageInput,
  registerPushTokenInput,
  type ChatMessage,
  type ConversationSummary,
} from "@homegrown/shared";
import { protectedProcedure, router } from "../trpc";
import {
  conversations,
  messages,
  stores,
  users,
  userBlocks,
  messageReports,
  pushTokens,
} from "../db/schema";
import {
  encodeKeysetCursor,
  decodeKeysetCursor,
  encodeKeysetCursorParts,
  decodeKeysetCursorParts,
  loadSourcingRequestsByIds,
} from "./helpers";
import type { Db } from "../context";

/** Preview text on `conversations.list` rows is truncated server-side to this length. */
const PREVIEW_MAX_CHARS = 120;
/** Push notification body is truncated to this length. */
const PUSH_BODY_MAX_CHARS = 100;

/** Exported for unit testing — see chat.test.ts. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// Cursor codecs — thin wrappers over the shared keyset codec in helpers.ts
// (same convention as garden.feed / orders.listForMyStore). Exported for
// direct unit testing (see chat.test.ts) — the nullable-lastMessageAt
// conversations variant has enough branches to warrant direct coverage.
// ---------------------------------------------------------------------------

/** Messages cursor: (createdAt, id) — createdAt is never null. */
export function encodeMessagesCursor(createdAt: Date, id: string): string {
  return encodeKeysetCursor(createdAt, id);
}

export function decodeMessagesCursor(raw: string): { createdAt: Date; id: string } {
  return decodeKeysetCursor(raw);
}

/**
 * Conversations cursor: (lastMessageAt | null, id). `lastMessageAt` is
 * encoded as an empty string when null (a conversation with no messages yet)
 * — those sort last under NULLS LAST, so an empty-string sentinel never
 * collides with a real ISO timestamp.
 */
export function encodeConversationsCursor(lastMessageAt: Date | null, id: string): string {
  return encodeKeysetCursorParts(lastMessageAt ? lastMessageAt.toISOString() : "", id);
}

export function decodeConversationsCursor(raw: string): { lastMessageAt: Date | null; id: string } {
  const { dateStr, id } = decodeKeysetCursorParts(raw);
  if (dateStr === "") return { lastMessageAt: null, id };
  const parsedDate = new Date(dateStr);
  if (isNaN(parsedDate.getTime())) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
  return { lastMessageAt: parsedDate, id };
}

/** Normalise a driver-returned timestamp (Date, string, or null) to a Date or null. */
function toDateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

// ---------------------------------------------------------------------------
// Participant resolution — shared by messages / send / markRead
// ---------------------------------------------------------------------------

interface ParticipantConversation {
  id: string;
  buyerId: string;
  storeId: string;
  storeUserId: string;
  storeName: string;
  buyerName: string;
  buyerLastReadAt: Date | null;
  sellerLastReadAt: Date | null;
}

/**
 * Resolve a conversation and verify `callerId` is a participant (the buyer or
 * the store owner). Throws NOT_FOUND — not FORBIDDEN — when the conversation
 * doesn't exist OR the caller isn't a participant, so a non-participant can't
 * distinguish the two cases.
 */
async function resolveParticipant(
  db: Db,
  conversationId: string,
  callerId: string,
): Promise<ParticipantConversation> {
  const [row] = await db
    .select({
      id: conversations.id,
      buyerId: conversations.buyerId,
      storeId: conversations.storeId,
      storeUserId: stores.userId,
      storeName: stores.name,
      buyerName: users.username,
      buyerLastReadAt: conversations.buyerLastReadAt,
      sellerLastReadAt: conversations.sellerLastReadAt,
    })
    .from(conversations)
    .innerJoin(stores, eq(stores.id, conversations.storeId))
    .innerJoin(users, eq(users.id, conversations.buyerId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!row || (row.buyerId !== callerId && row.storeUserId !== callerId)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Conversation not found" });
  }

  return row;
}

/** Whether `a` and `b` block each other in either direction. Exported for chat.test.ts. */
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
// Rate limiting — pilot-appropriate, DB-count based (no Redis / extra infra).
// Each check counts the caller's recent rows in the relevant table and throws
// TOO_MANY_REQUESTS when the window is full. Single-region, low-volume pilot:
// a COUNT over an indexed (user, created_at) range is plenty.
// ---------------------------------------------------------------------------

/** `send`: max messages per sender (across ALL conversations) per window. */
const SEND_RATE_LIMIT = { max: 30, windowMs: 60_000 };
/** `reportMessage`: max reports per reporter per window. */
const REPORT_RATE_LIMIT = { max: 10, windowMs: 60 * 60_000 };
/** `registerPushToken`: max DISTINCT tokens registered per user per window (see below). */
const PUSH_TOKEN_RATE_LIMIT = { max: 10, windowMs: 60 * 60_000 };

/**
 * Throw TOO_MANY_REQUESTS when a sender has hit the `send` window
 * (SEND_RATE_LIMIT). Counts messages by sender across all conversations —
 * served by messages_sender_user_id_created_at_idx. Exported for chat.test.ts.
 */
export async function assertSendRateLimit(db: Db, senderUserId: string): Promise<void> {
  const since = new Date(Date.now() - SEND_RATE_LIMIT.windowMs);
  const [row] = await db
    .select({ count: count() })
    .from(messages)
    .where(and(eq(messages.senderUserId, senderUserId), gte(messages.createdAt, since)));

  if ((row?.count ?? 0) >= SEND_RATE_LIMIT.max) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "You're sending messages too quickly. Please wait a moment.",
    });
  }
}

/** Throw TOO_MANY_REQUESTS when a reporter has hit the `reportMessage` window. */
async function assertReportRateLimit(db: Db, reporterUserId: string): Promise<void> {
  const since = new Date(Date.now() - REPORT_RATE_LIMIT.windowMs);
  const [row] = await db
    .select({ count: count() })
    .from(messageReports)
    .where(
      and(eq(messageReports.reporterUserId, reporterUserId), gte(messageReports.createdAt, since)),
    );

  if ((row?.count ?? 0) >= REPORT_RATE_LIMIT.max) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many reports. Please try again later.",
    });
  }
}

/**
 * Throw TOO_MANY_REQUESTS when a user has registered too many DISTINCT push
 * tokens recently. `push_tokens` upserts by token, so this counts rows whose
 * `updated_at` falls in the window — a known limitation: re-registering the
 * SAME token repeatedly stays at count 1 and is never throttled (harmless — it
 * rewrites one row), while the actual abuse vector (flooding many tokens onto
 * one account) is capped. Good enough for the pilot's single-region deployment
 * without adding a rate-limit store.
 */
async function assertPushTokenRateLimit(db: Db, userId: string): Promise<void> {
  const since = new Date(Date.now() - PUSH_TOKEN_RATE_LIMIT.windowMs);
  const [row] = await db
    .select({ count: count() })
    .from(pushTokens)
    .where(and(eq(pushTokens.userId, userId), gte(pushTokens.updatedAt, since)));

  if ((row?.count ?? 0) >= PUSH_TOKEN_RATE_LIMIT.max) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many device registrations. Please try again later.",
    });
  }
}

// ---------------------------------------------------------------------------
// list — raw-SQL row shape (nullable last_message_at, lateral last-message join)
// ---------------------------------------------------------------------------

interface ConversationRow {
  id: string;
  store_id: string;
  store_name: string;
  store_user_id: string;
  buyer_id: string;
  buyer_name: string;
  last_message_body: string | null;
  last_message_at: Date | string | null;
  unread_count: string | number;
}

function toConversationSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    storeId: row.store_id,
    storeName: row.store_name,
    storeUserId: row.store_user_id,
    buyerId: row.buyer_id,
    buyerName: row.buyer_name,
    lastMessageBody:
      row.last_message_body !== null ? truncate(row.last_message_body, PREVIEW_MAX_CHARS) : null,
    lastMessageAt: toDateOrNull(row.last_message_at)?.toISOString() ?? null,
    unreadCount: Number(row.unread_count),
  };
}

export const chatRouter = router({
  /**
   * Start (or resume) a conversation with a store (buyer-authed).
   * Idempotent per (buyer_id, store_id) — upserts and returns the existing
   * conversation's id if one is already open.
   */
  start: protectedProcedure
    .input(startConversationInput)
    .output(startConversationOutput)
    .mutation(async ({ input, ctx }) => {
      const [targetStore] = await ctx.db
        .select({ id: stores.id, userId: stores.userId })
        .from(stores)
        .where(eq(stores.id, input.storeId))
        .limit(1);

      if (!targetStore) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Store not found" });
      }

      if (targetStore.userId === ctx.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You can't start a conversation with your own store",
        });
      }

      if (await isBlockedEitherDirection(ctx.db, ctx.user.id, targetStore.userId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can't start a conversation with this store",
        });
      }

      const [row] = await ctx.db
        .insert(conversations)
        .values({ buyerId: ctx.user.id, storeId: targetStore.id })
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

      return { conversationId: row.id };
    }),

  /**
   * The caller's inbox: conversations where they're the buyer OR the store
   * owner. Most-recent-activity first (last_message_at DESC NULLS LAST, id
   * DESC); keyset cursor-paginated.
   */
  list: protectedProcedure
    .input(conversationsListInput)
    .output(conversationsListOutput)
    .query(async ({ input, ctx }) => {
      const { cursor, limit } = input;
      const callerId = ctx.user.id;

      let cursorLastMessageAt: Date | null | undefined;
      let cursorId: string | null = null;
      if (cursor) {
        const decoded = decodeConversationsCursor(cursor);
        cursorLastMessageAt = decoded.lastMessageAt;
        cursorId = decoded.id;
      }

      // Keyset predicate for ORDER BY last_message_at DESC NULLS LAST, id DESC:
      //   - cursor row had a non-null last_message_at V: next rows are
      //     (last_message_at < V) OR (last_message_at = V AND id < cursorId)
      //     OR (last_message_at IS NULL) — nulls always sort after any non-null.
      //   - cursor row had a null last_message_at: remaining pages are only
      //     within the null group, ordered by id DESC.
      let keysetFilter = sql``;
      if (cursorId !== null) {
        if (cursorLastMessageAt) {
          const iso = cursorLastMessageAt.toISOString();
          keysetFilter = sql`AND (
            c.last_message_at < ${iso}::timestamptz
            OR (c.last_message_at = ${iso}::timestamptz AND c.id < ${cursorId})
            OR c.last_message_at IS NULL
          )`;
        } else {
          keysetFilter = sql`AND (c.last_message_at IS NULL AND c.id < ${cursorId})`;
        }
      }

      const rows = await ctx.db.execute(sql`
        SELECT
          c.id,
          c.store_id,
          s.name AS store_name,
          s.user_id AS store_user_id,
          c.buyer_id,
          u.username AS buyer_name,
          lm.body AS last_message_body,
          c.last_message_at,
          (
            SELECT count(*)::int FROM messages m
            WHERE m.conversation_id = c.id
              AND m.sender_user_id <> ${callerId}
              AND m.created_at > COALESCE(
                CASE WHEN c.buyer_id = ${callerId} THEN c.buyer_last_read_at ELSE c.seller_last_read_at END,
                '-infinity'::timestamptz
              )
          ) AS unread_count
        FROM conversations c
        JOIN stores s ON s.id = c.store_id
        JOIN users u ON u.id = c.buyer_id
        LEFT JOIN LATERAL (
          SELECT body FROM messages m2
          WHERE m2.conversation_id = c.id
          ORDER BY m2.created_at DESC, m2.id DESC
          LIMIT 1
        ) lm ON true
        WHERE (c.buyer_id = ${callerId} OR s.user_id = ${callerId})
        ${keysetFilter}
        ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
        LIMIT ${limit + 1}
      `);

      const convRows = rows as unknown as ConversationRow[];

      let nextCursor: string | null = null;
      if (convRows.length > limit) {
        const lastRow = convRows[limit - 1]!;
        nextCursor = encodeConversationsCursor(toDateOrNull(lastRow.last_message_at), lastRow.id);
      }

      const items = convRows.slice(0, limit).map(toConversationSummary);

      return { items, nextCursor };
    }),

  /**
   * Newest-first, keyset-paginated messages within a conversation.
   * Participant-only — non-participants get NOT_FOUND (existence not leaked).
   */
  messages: protectedProcedure
    .input(messagesListInput)
    .output(messagesListOutput)
    .query(async ({ input, ctx }) => {
      await resolveParticipant(ctx.db, input.conversationId, ctx.user.id);

      let cursorCreatedAt: Date | null = null;
      let cursorId: string | null = null;
      if (input.cursor) {
        const decoded = decodeMessagesCursor(input.cursor);
        cursorCreatedAt = decoded.createdAt;
        cursorId = decoded.id;
      }

      const keysetCondition =
        cursorCreatedAt !== null && cursorId !== null
          ? or(
              lt(messages.createdAt, cursorCreatedAt),
              and(eq(messages.createdAt, cursorCreatedAt), lt(messages.id, cursorId)),
            )
          : undefined;

      const whereClause = keysetCondition
        ? and(eq(messages.conversationId, input.conversationId), keysetCondition)
        : eq(messages.conversationId, input.conversationId);

      const rows = await ctx.db
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          senderUserId: messages.senderUserId,
          body: messages.body,
          sourcingRequestId: messages.sourcingRequestId,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(whereClause)
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(input.limit + 1);

      let nextCursor: string | null = null;
      if (rows.length > input.limit) {
        const lastRow = rows[input.limit - 1]!;
        nextCursor = encodeMessagesCursor(lastRow.createdAt ?? new Date(), lastRow.id);
      }

      const pageRows = rows.slice(0, input.limit);

      // F-049 — attach the structured request/offer "card" to its originating
      // message (null for everything else, including the plain-text
      // accept/decline/withdraw follow-ups). Batch-loaded to avoid an N+1.
      const sourcingRequestIds = [
        ...new Set(
          pageRows
            .map((row) => row.sourcingRequestId)
            .filter((id): id is string => id !== null),
        ),
      ];
      const sourcingMap = await loadSourcingRequestsByIds(ctx.db, sourcingRequestIds);

      const items: ChatMessage[] = pageRows.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        senderUserId: row.senderUserId,
        body: row.body,
        sourcingRequest: row.sourcingRequestId ? (sourcingMap.get(row.sourcingRequestId) ?? null) : null,
        createdAt: (row.createdAt ?? new Date()).toISOString(),
      }));

      return { items, nextCursor };
    }),

  /**
   * Send a message. Participant-only; rate-limited per sender; rejects if
   * either party blocks the other. After the write commits, sends a
   * best-effort push notification to the OTHER party's registered devices
   * (a push failure never fails the mutation).
   */
  send: protectedProcedure
    .input(sendMessageInput)
    .output(chatMessage)
    .mutation(async ({ input, ctx }) => {
      const participant = await resolveParticipant(ctx.db, input.conversationId, ctx.user.id);
      const callerId = ctx.user.id;
      const isCallerBuyer = participant.buyerId === callerId;
      const otherUserId = isCallerBuyer ? participant.storeUserId : participant.buyerId;

      if (await isBlockedEitherDirection(ctx.db, callerId, otherUserId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can't send messages in this conversation",
        });
      }

      await assertSendRateLimit(ctx.db, callerId);

      const inserted = await ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(messages)
          .values({
            conversationId: input.conversationId,
            senderUserId: callerId,
            body: input.body,
          })
          .returning({
            id: messages.id,
            conversationId: messages.conversationId,
            senderUserId: messages.senderUserId,
            body: messages.body,
            createdAt: messages.createdAt,
          });

        if (!row) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to send message",
          });
        }

        await tx
          .update(conversations)
          .set({ lastMessageAt: row.createdAt ?? new Date() })
          .where(eq(conversations.id, input.conversationId));

        return row;
      });

      // Push to the OTHER party, AFTER the transaction commits. AWAITED on
      // purpose: on Cloud Run (minScale 0, CPU throttled outside requests) a
      // fire-and-forget promise can be starved or reclaimed once the response
      // flushes, silently dropping the notification. The try/catch preserves
      // the never-throws guarantee — a push failure (ctx.push.send already
      // swallows its own errors; this catches everything else, e.g. the token
      // lookup) must never fail the committed message.
      try {
        const tokens = await ctx.db
          .select({ token: pushTokens.token })
          .from(pushTokens)
          .where(eq(pushTokens.userId, otherUserId));

        if (tokens.length > 0) {
          const senderName = isCallerBuyer ? participant.buyerName : participant.storeName;

          await ctx.push.send({
            tokens: tokens.map((t) => t.token),
            title: senderName,
            body: truncate(input.body, PUSH_BODY_MAX_CHARS),
            data: { conversationId: input.conversationId },
          });
        }
      } catch (err) {
        // Never let a push-path failure escape and affect the caller — the
        // message is already committed.
        console.error(
          "[chat.send] push notification failed",
          err instanceof Error ? err.message : String(err),
        );
      }

      return {
        id: inserted.id,
        conversationId: inserted.conversationId,
        senderUserId: inserted.senderUserId,
        body: inserted.body,
        // chat.send never creates a sourcing-request card — those are only
        // attached via sourcing.createRequest / sourcing.createOffer.
        sourcingRequest: null,
        createdAt: (inserted.createdAt ?? new Date()).toISOString(),
      };
    }),

  /** Mark the caller's side of a conversation read (participant-only). */
  markRead: protectedProcedure
    .input(markConversationReadInput)
    .output(z.object({ success: z.literal(true) }))
    .mutation(async ({ input, ctx }) => {
      const participant = await resolveParticipant(ctx.db, input.conversationId, ctx.user.id);
      const isCallerBuyer = participant.buyerId === ctx.user.id;

      await ctx.db
        .update(conversations)
        .set(isCallerBuyer ? { buyerLastReadAt: new Date() } : { sellerLastReadAt: new Date() })
        .where(eq(conversations.id, input.conversationId));

      return { success: true };
    }),

  /** Block a user (idempotent — no error if already blocked). */
  blockUser: protectedProcedure
    .input(blockUserInput)
    .output(z.object({ success: z.literal(true) }))
    .mutation(async ({ input, ctx }) => {
      if (input.userId === ctx.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You can't block yourself" });
      }

      await ctx.db
        .insert(userBlocks)
        .values({ blockerUserId: ctx.user.id, blockedUserId: input.userId })
        .onConflictDoNothing();

      return { success: true };
    }),

  /**
   * Report a message (App Store Guideline 1.2 UGC moderation). The reporter
   * must be a participant of the message's conversation, else NOT_FOUND.
   */
  reportMessage: protectedProcedure
    .input(reportMessageInput)
    .output(z.object({ success: z.literal(true) }))
    .mutation(async ({ input, ctx }) => {
      const [msg] = await ctx.db
        .select({ id: messages.id, conversationId: messages.conversationId })
        .from(messages)
        .where(eq(messages.id, input.messageId))
        .limit(1);

      if (!msg) {
        // Same message as the participancy failure below — a prober must not
        // distinguish "no such message" from "exists but not yours to see".
        throw new TRPCError({ code: "NOT_FOUND", message: "Conversation not found" });
      }

      // Verifies participancy; throws NOT_FOUND if the caller isn't one.
      await resolveParticipant(ctx.db, msg.conversationId, ctx.user.id);

      await assertReportRateLimit(ctx.db, ctx.user.id);

      await ctx.db.insert(messageReports).values({
        messageId: input.messageId,
        reporterUserId: ctx.user.id,
        reason: input.reason,
      });

      return { success: true };
    }),

  /**
   * Register (or move ownership of) an Expo push token for the caller's
   * device. Upsert by token — re-registering an existing token moves it to
   * the new user (the device changed accounts).
   */
  registerPushToken: protectedProcedure
    .input(registerPushTokenInput)
    .output(z.object({ success: z.literal(true) }))
    .mutation(async ({ input, ctx }) => {
      await assertPushTokenRateLimit(ctx.db, ctx.user.id);

      await ctx.db
        .insert(pushTokens)
        .values({ token: input.token, userId: ctx.user.id, platform: input.platform })
        .onConflictDoUpdate({
          target: pushTokens.token,
          set: { userId: ctx.user.id, platform: input.platform, updatedAt: new Date() },
        });

      return { success: true };
    }),
});
