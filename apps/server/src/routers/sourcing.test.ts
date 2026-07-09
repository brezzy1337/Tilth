/**
 * Unit tests for pure/small helpers in the sourcing router (F-049).
 *
 * No real DB — `resolveCallerPlace` is exercised against a minimal fake
 * select() builder (mirrors the fakeGardenDb / chat.test.ts pattern).
 *
 * Full router behavior (createRequest/createOffer/respond/withdraw/listMine/
 * growers, including authz, state transitions, and geo ordering) is covered
 * by sourcing.integration.test.ts against a real Postgres instance — those
 * flows are too join/transaction-heavy to usefully fake here.
 *
 * Covers:
 *   - buildCreateRequestBody / buildCreateOfferBody: with and without neededBy.
 *   - buildRespondBody: accepted vs declined wording.
 *   - buildWithdrawBody.
 *   - resolveCallerPlace: returns the place when found, throws NOT_FOUND
 *     otherwise.
 */

import { describe, it, expect } from "vitest";
import {
  buildCreateRequestBody,
  buildCreateOfferBody,
  buildRespondBody,
  buildWithdrawBody,
  resolveCallerPlace,
} from "./sourcing";
import type { Db } from "../context";

describe("sourcing — message body summaries", () => {
  it("buildCreateRequestBody without neededBy", () => {
    expect(buildCreateRequestBody("20 lb", "Tomatoes", null)).toBe(
      "Fulfillment request: 20 lb of Tomatoes",
    );
  });

  it("buildCreateRequestBody with neededBy", () => {
    expect(buildCreateRequestBody("20 lb", "Tomatoes", "2026-07-17")).toBe(
      "Fulfillment request: 20 lb of Tomatoes — needed by 2026-07-17",
    );
  });

  it("buildCreateOfferBody without neededBy", () => {
    expect(buildCreateOfferBody("6 flats", "Basil", null)).toBe(
      "Offer to supply: 6 flats of Basil",
    );
  });

  it("buildCreateOfferBody with neededBy", () => {
    expect(buildCreateOfferBody("6 flats", "Basil", "2026-08-01")).toBe(
      "Offer to supply: 6 flats of Basil — available by 2026-08-01",
    );
  });

  it("buildRespondBody: accepted", () => {
    expect(buildRespondBody("accepted", "20 lb", "Tomatoes")).toBe(
      "Accepted the fulfillment request: 20 lb of Tomatoes",
    );
  });

  it("buildRespondBody: declined", () => {
    expect(buildRespondBody("declined", "20 lb", "Tomatoes")).toBe(
      "Declined the fulfillment request: 20 lb of Tomatoes",
    );
  });

  it("buildWithdrawBody", () => {
    expect(buildWithdrawBody("20 lb", "Tomatoes")).toBe(
      "Withdrew the fulfillment request: 20 lb of Tomatoes",
    );
  });
});

describe("sourcing — resolveCallerPlace", () => {
  const UUID_A = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

  function fakeDb(placeRows: Array<{ id: string; name: string }>): Db {
    const selectBuilder = {
      from: () => selectBuilder,
      where: () => selectBuilder,
      limit: () => Promise.resolve(placeRows),
    };
    return { select: () => selectBuilder } as unknown as Db;
  }

  it("returns the place when the caller has a linked approved place", async () => {
    const db = fakeDb([{ id: UUID_A, name: "River Co-op" }]);
    await expect(resolveCallerPlace(db, UUID_A)).resolves.toEqual({ id: UUID_A, name: "River Co-op" });
  });

  it("throws NOT_FOUND when the caller has no linked place", async () => {
    const db = fakeDb([]);
    await expect(resolveCallerPlace(db, UUID_A)).rejects.toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });
});
