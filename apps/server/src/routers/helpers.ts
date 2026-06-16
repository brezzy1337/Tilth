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
import type { Db } from "../context";
import { stores } from "../db/schema";

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
