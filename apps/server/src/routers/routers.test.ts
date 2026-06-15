/**
 * Router integration tests — use createCallerFactory with stub contexts.
 *
 * No real DB or env required. We build minimal fake db objects that return
 * pre-programmed results for the specific query chains each procedure uses.
 *
 * Drizzle's query builder chains (select/from/where/limit, insert/values/returning)
 * are faked as thenable builder objects so procedures can await them normally.
 */

import { describe, it, expect } from "vitest";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context } from "../context";
import * as authHelpers from "../auth";

const createCaller = createCallerFactory(appRouter);

// ---------------------------------------------------------------------------
// Valid v4 UUIDs for tests (Zod v4 enforces strict UUID format)
// ---------------------------------------------------------------------------
const UUID1 = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const UUID2 = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const UUID3 = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33";
const UUID4 = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44";
const UUID5 = "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55";
const UUID6 = "f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66";
const UUID7 = "a1eebc99-9c0b-4ef8-bb6d-6bb9bd380a77";
const STORE_UUID1 = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a88";
const STORE_UUID2 = "c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a99";

// ---------------------------------------------------------------------------
// Fake DB builder helpers
// ---------------------------------------------------------------------------

/** Combines select and insert fakes into one db-shaped object. */
function fakeDb(opts: {
  selectRows?: unknown[];
  insertRows?: unknown[];
  /** Allow multiple selects to return different rows in sequence */
  selectSequence?: unknown[][];
}) {
  let selectCallCount = 0;

  const selectFn = () => {
    const rows =
      opts.selectSequence
        ? (opts.selectSequence[selectCallCount++] ?? [])
        : (opts.selectRows ?? []);

    const builder = {
      from: () => builder,
      where: () => builder,
      limit: () => Promise.resolve(rows),
    };
    return builder;
  };

  const insertBuilder = {
    values: () => insertBuilder,
    returning: () => Promise.resolve(opts.insertRows ?? []),
  };
  const insertFn = () => insertBuilder;

  return { select: selectFn, insert: insertFn } as unknown as Context["db"];
}

const TEST_SECRET = "test-jwt-secret-that-is-at-least-32-chars";

/** Real auth helpers — safe to use in tests since this file runs under server tsconfig. */
const stubAuth: Context["auth"] = {
  hashPassword: authHelpers.hashPassword,
  verifyPassword: authHelpers.verifyPassword,
  signToken: authHelpers.signToken,
  verifyToken: authHelpers.verifyToken,
};

// ---------------------------------------------------------------------------
// auth.register
// ---------------------------------------------------------------------------

describe("auth.register", () => {
  it("happy path: creates user and returns token + session user", async () => {
    const db = fakeDb({
      selectRows: [], // no existing user
      insertRows: [
        { id: UUID1, email: "alice@example.com", username: "alice" },
      ],
    });

    const ctx: Context = { db, jwtSecret: TEST_SECRET, auth: stubAuth, user: null };
    const caller = createCaller(ctx);

    const result = await caller.auth.register({
      email: "alice@example.com",
      username: "alice",
      password: "password123",
    });

    expect(result.user.id).toBe(UUID1);
    expect(result.user.email).toBe("alice@example.com");
    expect(result.user.username).toBe("alice");
    expect(result.token).toBeTruthy();
    expect(typeof result.token).toBe("string");
    // The token must not contain any password
    expect(result.token).not.toContain("password");
  });

  it("throws CONFLICT when email/username already exists", async () => {
    const db = fakeDb({
      selectRows: [{ id: UUID2 }], // existing user found
    });

    const ctx: Context = { db, jwtSecret: TEST_SECRET, auth: stubAuth, user: null };
    const caller = createCaller(ctx);

    await expect(
      caller.auth.register({
        email: "taken@example.com",
        username: "taken",
        password: "password123",
      }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    );
  });
});

// ---------------------------------------------------------------------------
// auth.login
// ---------------------------------------------------------------------------

describe("auth.login", () => {
  it("happy path: returns token + session user on correct credentials", async () => {
    // Pre-hash "mypassword" to set up the fake DB
    const storedHash = await authHelpers.hashPassword("mypassword");

    const db = fakeDb({
      selectRows: [
        {
          id: UUID3,
          email: "bob@example.com",
          username: "bob",
          passwordHash: storedHash,
        },
      ],
    });

    const ctx: Context = { db, jwtSecret: TEST_SECRET, auth: stubAuth, user: null };
    const caller = createCaller(ctx);

    const result = await caller.auth.login({
      usernameOrEmail: "bob@example.com",
      password: "mypassword",
    });

    expect(result.user.id).toBe(UUID3);
    expect(result.user.email).toBe("bob@example.com");
    expect(result.token).toBeTruthy();
  });

  it("throws UNAUTHORIZED on wrong password (generic message)", async () => {
    const storedHash = await authHelpers.hashPassword("correctpassword");

    const db = fakeDb({
      selectRows: [
        {
          id: UUID4,
          email: "carol@example.com",
          username: "carol",
          passwordHash: storedHash,
        },
      ],
    });

    const ctx: Context = { db, jwtSecret: TEST_SECRET, auth: stubAuth, user: null };
    const caller = createCaller(ctx);

    await expect(
      caller.auth.login({
        usernameOrEmail: "carol@example.com",
        password: "wrongpassword",
      }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });

  it("throws UNAUTHORIZED when user not found", async () => {
    const db = fakeDb({ selectRows: [] });

    const ctx: Context = { db, jwtSecret: TEST_SECRET, auth: stubAuth, user: null };
    const caller = createCaller(ctx);

    await expect(
      caller.auth.login({
        usernameOrEmail: "nobody@example.com",
        password: "anything",
      }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });
});

// ---------------------------------------------------------------------------
// auth.me
// ---------------------------------------------------------------------------

describe("auth.me", () => {
  it("returns the authenticated principal from a DB read", async () => {
    const db = fakeDb({
      selectRows: [
        { id: UUID5, email: "dave@example.com", username: "dave" },
      ],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      user: { id: UUID5 },
    };
    const caller = createCaller(ctx);

    const result = await caller.auth.me();
    expect(result.id).toBe(UUID5);
    expect(result.email).toBe("dave@example.com");
    expect(result.username).toBe("dave");
  });

  it("throws UNAUTHORIZED when unauthenticated", async () => {
    const db = fakeDb({ selectRows: [] });
    const ctx: Context = { db, jwtSecret: TEST_SECRET, auth: stubAuth, user: null };
    const caller = createCaller(ctx);

    await expect(caller.auth.me()).rejects.toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });
});

// ---------------------------------------------------------------------------
// stores.getMine — also verifies protectedProcedure rejects unauthenticated
// ---------------------------------------------------------------------------

describe("stores.getMine", () => {
  it("throws UNAUTHORIZED when ctx.user is null", async () => {
    const db = fakeDb({ selectRows: [] });
    const ctx: Context = { db, jwtSecret: TEST_SECRET, auth: stubAuth, user: null };
    const caller = createCaller(ctx);

    await expect(caller.stores.getMine()).rejects.toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });

  it("returns null when the user has no store", async () => {
    const db = fakeDb({ selectRows: [] });
    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      user: { id: UUID6 },
    };
    const caller = createCaller(ctx);

    const result = await caller.stores.getMine();
    expect(result).toBeNull();
  });

  it("returns the store when the user has one", async () => {
    const db = fakeDb({
      selectRows: [
        {
          id: STORE_UUID1,
          userId: UUID6,
          name: "Eve's Farm",
          logo: null,
          about: null,
          stripeConnectAccountId: null,
        },
      ],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      user: { id: UUID6 },
    };
    const caller = createCaller(ctx);

    const result = await caller.stores.getMine();
    expect(result).not.toBeNull();
    expect(result?.id).toBe(STORE_UUID1);
    expect(result?.name).toBe("Eve's Farm");
  });
});

// ---------------------------------------------------------------------------
// stores.create
// ---------------------------------------------------------------------------

describe("stores.create", () => {
  it("creates a store when the user has none", async () => {
    const db = fakeDb({
      selectRows: [], // no existing store
      insertRows: [
        {
          id: STORE_UUID2,
          userId: UUID7,
          name: "Frank's Veggies",
          logo: null,
          about: null,
          stripeConnectAccountId: null,
        },
      ],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      user: { id: UUID7 },
    };
    const caller = createCaller(ctx);

    const result = await caller.stores.create({ name: "Frank's Veggies" });
    expect(result.id).toBe(STORE_UUID2);
    expect(result.name).toBe("Frank's Veggies");
    expect(result.userId).toBe(UUID7);
  });

  it("throws CONFLICT when the user already has a store", async () => {
    const db = fakeDb({
      selectRows: [{ id: STORE_UUID1 }], // already has store
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      user: { id: UUID7 },
    };
    const caller = createCaller(ctx);

    await expect(
      caller.stores.create({ name: "Another Store" }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    );
  });

  it("throws UNAUTHORIZED when unauthenticated", async () => {
    const db = fakeDb({ selectRows: [] });
    const ctx: Context = { db, jwtSecret: TEST_SECRET, auth: stubAuth, user: null };
    const caller = createCaller(ctx);

    await expect(
      caller.stores.create({ name: "Should Fail" }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });
});
