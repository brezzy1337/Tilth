/**
 * Integration test for the appRouter.
 *
 * Uses the caller factory with a stub context — no env vars or DB connection
 * required. This must remain true: the router tree must never import `env`
 * or `db` directly.
 *
 * The health router uses no db and no auth, so the db stub can be a minimal
 * typed placeholder and jwtSecret can be any 32-char string.
 */

import { describe, it, expect } from "vitest";
import { healthResponse } from "@homegrown/shared";
import { appRouter } from "./router";
import { createCallerFactory } from "./trpc";
import type { Context } from "./context";

const createCaller = createCallerFactory(appRouter);

// Minimal stub context that satisfies the Context shape.
// health.ping does not use db, auth, or jwtSecret — passing typed no-ops is enough.
const stubCtx: Context = {
  db: {} as Context["db"],
  jwtSecret: "stub-secret-for-testing-only-32ch",
  auth: {} as Context["auth"],
  user: null,
};

const caller = createCaller(stubCtx);

describe("health.ping", () => {
  it("returns a response that satisfies the healthResponse contract", async () => {
    const result = await caller.health.ping();

    // Must parse without throwing — validates shape, types, and constraints
    const parsed = healthResponse.parse(result);
    expect(parsed.status).toBe("ok");
  });

  it("returns status ok", async () => {
    const result = await caller.health.ping();
    expect(result.status).toBe("ok");
  });

  it("returns service name homegrown-server", async () => {
    const result = await caller.health.ping();
    expect(result.service).toBe("homegrown-server");
  });

  it("returns a non-negative uptimeSeconds", async () => {
    const result = await caller.health.ping();
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("returns a valid ISO 8601 timestamp", async () => {
    const result = await caller.health.ping();
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
    expect(result.timestamp).toBe(new Date(result.timestamp).toISOString());
  });
});
