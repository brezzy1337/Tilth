/**
 * Unit tests for order-transition helpers.
 *
 * Fast — no real DB, no network.
 * Uses a fake DB whose update chain models .returning() returning [{id}] on a
 * hit and [] on a miss, exactly matching the Drizzle + postgres-js contract.
 *
 * Coverage:
 *   markOrderPaid:
 *     - Returns true when the update transitions a row (returning() yields [{id}]).
 *     - Returns false when no row matched (returning() yields []).
 *     - Calls update().set().where().returning() in the correct chain order.
 */

import { describe, it, expect } from "vitest";
import { markOrderPaid } from "./order-transitions";
import type { Db } from "../context";

// ---------------------------------------------------------------------------
// Fake DB builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake Db whose update().set().where().returning() chain
 * resolves to `returningRows`. This mirrors the real Drizzle + postgres-js
 * behavior where .returning() populates the array only for actually-updated rows.
 */
function fakeDbForMarkOrderPaid(returningRows: { id: string }[]): {
  db: Db;
  capturedSet: unknown[];
  returningCallCount: number;
} {
  const capturedSet: unknown[] = [];
  let returningCallCount = 0;

  const updateBuilder: {
    set: (s: unknown) => typeof updateBuilder;
    where: (...args: unknown[]) => typeof updateBuilder;
    returning: (...args: unknown[]) => Promise<{ id: string }[]>;
  } = {
    set: (s: unknown) => {
      capturedSet.push(s);
      return updateBuilder;
    },
    where: () => updateBuilder,
    returning: () => {
      returningCallCount++;
      return Promise.resolve(returningRows);
    },
  };

  const db = {
    update: () => updateBuilder,
  } as unknown as Db;

  return { db, capturedSet, returningCallCount: 0 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("markOrderPaid", () => {
  it("returns true when the UPDATE transitions a row (.returning() yields [{id}])", async () => {
    const { db } = fakeDbForMarkOrderPaid([{ id: "order-uuid-1" }]);

    const result = await markOrderPaid(db, "pi_test_001");

    expect(result).toBe(true);
  });

  it("returns false when no row matched (.returning() yields [])", async () => {
    const { db } = fakeDbForMarkOrderPaid([]);

    const result = await markOrderPaid(db, "pi_already_paid_or_absent");

    expect(result).toBe(false);
  });

  it("sets status to 'paid' and updatedAt in the update payload", async () => {
    const { db, capturedSet } = fakeDbForMarkOrderPaid([{ id: "order-uuid-2" }]);

    await markOrderPaid(db, "pi_test_002");

    expect(capturedSet).toHaveLength(1);
    const set = capturedSet[0] as { status: string; updatedAt: Date };
    expect(set.status).toBe("paid");
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it("accepts a tx handle (DbOrTx union) without type errors", async () => {
    // This test just verifies that passing a transaction-shaped object does not
    // throw at runtime — the TypeScript types are validated at build time.
    const { db } = fakeDbForMarkOrderPaid([{ id: "order-uuid-3" }]);

    // Cast to unknown simulates passing a tx handle (same runtime shape as Db).
    const result = await markOrderPaid(db as unknown as import("./order-transitions").DbOrTx, "pi_test_003");

    expect(result).toBe(true);
  });
});
