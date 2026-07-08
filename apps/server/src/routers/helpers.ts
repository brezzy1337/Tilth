/**
 * Shared router helpers — tiny utilities used by multiple routers.
 *
 * Rules that must hold here:
 *   - No imports of env or any module with side-effects.
 *   - All deps (db, userId) are passed as parameters — never read from globals.
 *   - Never log secrets or user-identifying data.
 */

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../context";
import { stores } from "../db/schema";

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
 * Returns `{ id: string }` if found, or throws a NOT_FOUND TRPCError
 * with the canonical "You do not have a store. Create one first." message.
 *
 * Delegates to `resolveCallerStoreWithConnect` so the SELECT + NOT_FOUND
 * logic lives in exactly one place.
 */
export async function resolveCallerStore(db: Db, userId: string): Promise<{ id: string }> {
  const store = await resolveCallerStoreWithConnect(db, userId);
  return { id: store.id };
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
  stripeConnectAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}> {
  const [store] = await db
    .select({
      id: stores.id,
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
