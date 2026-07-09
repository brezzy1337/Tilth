/**
 * Unit + guarded-integration tests for the link-place-buyer CLI (F-049).
 *
 * `deriveUsername` is pure — no DB, no network. Importing `link-place-buyer.ts`
 * here never triggers the CLI (guarded by the `isMainModule` check at the
 * bottom of that file) or a DB connection (the drizzle client is created
 * lazily inside `getDb`, only reached from the command handlers, which the
 * unit tests below never call).
 */

import { describe, it, expect } from "vitest";
import { deriveUsername } from "./link-place-buyer";

describe("deriveUsername", () => {
  it("takes the local part of the email", () => {
    expect(deriveUsername("river.coop@example.com")).toBe("river_coop");
  });

  it("replaces non-alphanumeric/underscore characters with underscores", () => {
    expect(deriveUsername("river+coop.market@example.com")).toBe("river_coop_market");
  });

  it("pads short local parts up to the 3-char minimum", () => {
    expect(deriveUsername("ab@example.com")).toBe("ab_");
    expect(deriveUsername("a@example.com")).toBe("a__");
  });

  it("caps at 30 characters", () => {
    const long = "a".repeat(40);
    const result = deriveUsername(`${long}@example.com`);
    expect(result.length).toBe(30);
  });
});
