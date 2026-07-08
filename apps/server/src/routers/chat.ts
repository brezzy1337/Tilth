/**
 * Chat router — F-037/F-038 1:1 buyer<->store messaging (DIY, polling clients).
 *
 * `start`             — buyer-authed; idempotent upsert on (buyer_id, store_id).
 * `list`              — authed; the caller's inbox (as buyer OR as store owner),
 *                        most-recent-activity first, keyset cursor-paginated.
 * `messages`          — authed, participant-only; newest-first keyset pages.
 * `send`              — authed, participant-only; inserts a message, bumps
 *                        `last_message_at`, and fires a best-effort push
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
 *     swallows its own errors (see push.ts); this file never awaits it in a
 *     way that could reject the caller's request.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, and, or, lt, desc, sql } from "drizzle-orm";
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
// Cursor codecs — base64 keyset cursors, same convention as garden.feed /
// orders.listForMyStore. Exported for direct unit testing (see chat.test.ts) —
// same rationale as other cursor codecs in this codebase being exercised
// indirectly via the router in most files, but the nullable-lastMessageAt
// variant here has enough branches to warrant direct coverage.
// ---------------------------------------------------------------------------

/** Messages cursor: (createdAt, id) — createdAt is never null. */
export function encodeMessagesCursor(createdAt: Date, id: string): string {
  return btoa(`${createdAt.toISOString()}|${id}`);
}

export function decodeMessagesCursor(raw: string): { createdAt: Date; id: string } {
  try {
    const decoded = atob(raw);
    const sepIdx = decoded.indexOf("|");
    if (sepIdx === -1) throw new Error("missing separator");
    const dateStr = decoded.slice(0, sepIdx);
    const id = decoded.slice(sepIdx + 1);
    const parsedDate = new Date(dateStr);
    if (isNaN(parsedDate.getTime())) throw new Error("bad date");
    z.string().uuid().parse(id);
    return { createdAt: parsedDate, id };
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
}

/**
 * Conversations cursor: (lastMessageAt | null, id). `lastMessageAt` is
 * encoded as an empty string when null (a conversation with no messages yet)
 * — those sort last under NULLS LAST, so an empty-string sentinel never
 * collides with a real ISO timestamp.
 */
export function encodeConversationsCursor(lastMessageAt: Date | null, id: string): string {
  return btoa(`${lastMessageAt ? lastMessageAt.toISOString() : ""}|${id}`);
}

export function decodeConversationsCursor(raw: string): { lastMessageAt: Date | null; id: string } {
  try {
    const decoded = atob(raw);
    const sepIdx = decoded.indexOf("|");
    if (sepIdx === -1) throw new Error("missing separator");
    const dateStr = decoded.slice(0, sepIdx);
    const id = decoded.slice(sepIdx + 1);
    z.string().uuid().parse(id);
    if (dateStr === "") return { lastMessageAt: null, id };
    const parsedDate = new Date(dateStr);
    if (isNaN(parsedDate.getTime())) throw new Error("bad date");
    return { lastMessageAt: parsedDate, id };
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
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
// list — raw-SQL row shape (nullable last_message_at, lateral last-message join)
// ---------------------------------------------------------------------------

interface ConversationRow {
  id: string;
  store_id: string;
  store_name: string;
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

      const items: ChatMessage[] = rows.slice(0, input.limit).map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        senderUserId: row.senderUserId,
        body: row.body,
        createdAt: (row.createdAt ?? new Date()).toISOString(),
      }));

      return { items, nextCursor };
    }),

  /**
   * Send a message. Participant-only; rejects if either party blocks the
   * other. After the write commits, fires a best-effort push notification to
   * the OTHER party's registered devices (never fails the mutation).
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

      // Fire-and-forget push to the OTHER party, AFTER the transaction commits.
      // Never awaited in a way that could reject this mutation — ctx.push.send
      // itself never throws (see push.ts), and we additionally don't `await`
      // the outer call so a slow push send can't add latency to `send`.
      void (async () => {
        try {
          const tokens = await ctx.db
            .select({ token: pushTokens.token })
            .from(pushTokens)
            .where(eq(pushTokens.userId, otherUserId));
          if (tokens.length === 0) return;

          const senderName = isCallerBuyer ? participant.buyerName : participant.storeName;

          await ctx.push.send({
            tokens: tokens.map((t) => t.token),
            title: senderName,
            body: truncate(input.body, PUSH_BODY_MAX_CHARS),
            data: { conversationId: input.conversationId },
          });
        } catch (err) {
          // Belt-and-braces — ctx.push.send already swallows its own errors,
          // but never let anything here escape and affect the caller.
          console.error(
            "[chat.send] push notification failed",
            err instanceof Error ? err.message : String(err),
          );
        }
      })();

      return {
        id: inserted.id,
        conversationId: inserted.conversationId,
        senderUserId: inserted.senderUserId,
        body: inserted.body,
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
