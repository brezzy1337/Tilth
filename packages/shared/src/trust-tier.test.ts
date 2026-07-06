import { describe, it, expect } from "vitest";
import { computeTrustTier } from "./index.js";

describe("computeTrustTier", () => {
  it("returns null when there is no terminal order history", () => {
    expect(computeTrustTier({ fulfilled: 0, cancelled: 0, refunded: 0 })).toBeNull();
  });

  it("returns null when terminal volume is below the bronze minimum (5)", () => {
    // 4 fulfilled, 0 cancelled/refunded → 100% rate but terminal 4 < 5
    expect(computeTrustTier({ fulfilled: 4, cancelled: 0, refunded: 0 })).toBeNull();
  });

  it("earns bronze at exactly the 85% rate boundary (17/20, volume above minimum)", () => {
    // fulfilled 17, cancelled 2, refunded 1 → terminal 20 (>= 5), rate 0.85 exactly
    expect(computeTrustTier({ fulfilled: 17, cancelled: 2, refunded: 1 })).toBe("bronze");
  });

  it("earns bronze at exactly 5 terminal orders with rate >= 0.85", () => {
    // fulfilled 5, terminal 5 → rate 1.0, terminal 5 (boundary)
    expect(computeTrustTier({ fulfilled: 5, cancelled: 0, refunded: 0 })).toBe("bronze");
  });

  it("earns silver at exactly the 92% rate boundary (23/25, volume above minimum)", () => {
    // fulfilled 23, cancelled 1, refunded 1 → terminal 25 (>= 15), rate 0.92 exactly
    expect(computeTrustTier({ fulfilled: 23, cancelled: 1, refunded: 1 })).toBe("silver");
  });

  it("earns silver at exactly 15 terminal orders with rate >= 0.92", () => {
    // fulfilled 14, terminal 15 → rate 0.9333...
    expect(computeTrustTier({ fulfilled: 14, cancelled: 1, refunded: 0 })).toBe("silver");
  });

  it("earns gold at exactly the 97% rate boundary (97/100, volume above minimum)", () => {
    // fulfilled 97, cancelled 2, refunded 1 → terminal 100 (>= 30), rate 0.97 exactly
    expect(computeTrustTier({ fulfilled: 97, cancelled: 2, refunded: 1 })).toBe("gold");
  });

  it("earns gold at exactly 30 terminal orders with rate >= 0.97", () => {
    // fulfilled 29, terminal 30 → rate 0.9666... just below 0.97 -> should NOT be gold
    // Use fulfilled 30/terminal 30 = 1.0 to hit the exact boundary of terminal 30.
    expect(computeTrustTier({ fulfilled: 30, cancelled: 0, refunded: 0 })).toBe("gold");
  });

  it("drops to silver when rate is just below gold's 97% (96% at 30 terminal)", () => {
    // fulfilled 96, terminal 100 → rate 0.96 < 0.97
    expect(computeTrustTier({ fulfilled: 96, cancelled: 3, refunded: 1 })).toBe("silver");
  });

  it("drops to silver when rate meets gold but volume doesn't (97% at 20 terminal)", () => {
    // fulfilled 19, cancelled 1, refunded 0 → terminal 20, rate 0.95 (>= silver 0.92, terminal >= 15)
    // Need rate exactly >= 0.97 with terminal 20 (< 30) to prove it falls to silver, not gold.
    // 20 * 0.97 = 19.4 -> not integer; use terminal 20, fulfilled 20 (rate 1.0) still < 30 terminal for gold.
    expect(computeTrustTier({ fulfilled: 20, cancelled: 0, refunded: 0 })).toBe("silver");
  });

  it("returns null when rate is below bronze's 85% even with high volume (84% at 100 terminal)", () => {
    // fulfilled 84, terminal 100 → rate 0.84 < 0.85
    expect(computeTrustTier({ fulfilled: 84, cancelled: 10, refunded: 6 })).toBeNull();
  });

  it("counts both cancelled and refunded in the denominator (90% at 100 terminal → bronze)", () => {
    // fulfilled 90, cancelled 5, refunded 5 → terminal 100, rate 0.90
    expect(computeTrustTier({ fulfilled: 90, cancelled: 5, refunded: 5 })).toBe("bronze");
  });

  it("stays null for a perfect rate on volume below the bronze minimum (4/4)", () => {
    expect(computeTrustTier({ fulfilled: 4, cancelled: 0, refunded: 0 })).toBeNull();
  });
});
