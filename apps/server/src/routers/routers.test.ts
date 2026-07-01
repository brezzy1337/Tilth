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
  /** If set, the insert .returning() rejects with this error instead of resolving. */
  insertError?: unknown;
  /** Rows returned by update().set().where().returning() */
  updateRows?: unknown[];
  /** Rows returned by select().from().innerJoin().where().limit() */
  joinRows?: unknown[];
  /** Allow multiple joins to return different rows in sequence */
  joinSequence?: unknown[][];
}) {
  let selectCallCount = 0;
  let joinCallCount = 0;

  const selectFn = () => {
    const rows = opts.selectSequence
      ? (opts.selectSequence[selectCallCount++] ?? [])
      : (opts.selectRows ?? []);

    // Make builder thenable so procedures can await it directly (without .limit())
    // or call .limit() on it.
    const builder: {
      from: () => typeof builder;
      where: () => typeof builder;
      limit: () => Promise<unknown[]>;
      innerJoin: () => {
        where: () => { where: () => unknown; limit: () => Promise<unknown[]> };
        limit: () => Promise<unknown[]>;
      };
      then: (resolve: (v: unknown[]) => void, reject: (e: unknown) => void) => void;
    } = {
      from: () => builder,
      where: () => builder,
      limit: () => Promise.resolve(rows),
      // Support innerJoin chaining — routes to joinRows/joinSequence
      innerJoin: () => {
        const joinRows = opts.joinSequence
          ? (opts.joinSequence[joinCallCount++] ?? [])
          : (opts.joinRows ?? []);
        const joinBuilder = {
          where: () => joinBuilder,
          limit: () => Promise.resolve(joinRows),
        };
        return joinBuilder;
      },
      // Thenable: allow `await db.select().from().where()` without .limit()
      then: (resolve: (v: unknown[]) => void, reject: (e: unknown) => void) => {
        Promise.resolve(rows).then(resolve, reject);
      },
    };
    return builder;
  };

  const insertBuilder = {
    values: () => insertBuilder,
    onConflictDoUpdate: () => insertBuilder,
    returning: () =>
      opts.insertError !== undefined
        ? Promise.reject(opts.insertError)
        : Promise.resolve(opts.insertRows ?? []),
  };
  const insertFn = () => insertBuilder;

  const updateBuilder = {
    set: () => updateBuilder,
    where: () => updateBuilder,
    returning: () => Promise.resolve(opts.updateRows ?? []),
  };
  const updateFn = () => updateBuilder;

  return { select: selectFn, insert: insertFn, update: updateFn } as unknown as Context["db"];
}

const TEST_SECRET = "test-jwt-secret-that-is-at-least-32-chars";

/** Real auth helpers — safe to use in tests since this file runs under server tsconfig. */
const stubAuth: Context["auth"] = {
  hashPassword: authHelpers.hashPassword,
  verifyPassword: authHelpers.verifyPassword,
  signToken: authHelpers.signToken,
  verifyToken: authHelpers.verifyToken,
};

/** Stub StripeClient — existing router tests never call Stripe; stub keeps types happy. */
const stubStripe: Context["stripe"] = {
  createConnectedAccount: async () => { throw new Error("stub: not implemented"); },
  createAccountLink: async () => { throw new Error("stub: not implemented"); },
  retrieveAccountStatus: async () => { throw new Error("stub: not implemented"); },
  createPaymentIntent: async () => { throw new Error("stub: not implemented"); },
  retrievePaymentIntent: async () => { throw new Error("stub: not implemented"); },
  cancelPaymentIntent: async () => { throw new Error("stub: not implemented"); },
  capturePaymentIntent: async () => { throw new Error("stub: not implemented"); },
  refundPayment: async () => { throw new Error("stub: not implemented"); },
  createDashboardLink: async () => { throw new Error("stub: not implemented"); },
};

// ---------------------------------------------------------------------------
// auth.register
// ---------------------------------------------------------------------------

describe("auth.register", () => {
  it("happy path: creates user and returns token + session user", async () => {
    const db = fakeDb({
      selectRows: [], // no existing user
      insertRows: [{ id: UUID1, email: "alice@example.com", username: "alice" }],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
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

  it("throws CONFLICT when email/username already exists (precheck)", async () => {
    const db = fakeDb({
      selectRows: [{ id: UUID2 }], // existing user found
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    await expect(
      caller.auth.register({
        email: "taken@example.com",
        username: "taken",
        password: "password123",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("throws CONFLICT when INSERT races and yields a 23505 unique-violation", async () => {
    // Simulate a concurrent duplicate: the precheck SELECT finds nothing, but the
    // INSERT itself then throws SQLSTATE 23505 (the race window).
    const pgUniqueViolation = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    const db = fakeDb({
      selectRows: [], // precheck passes
      insertError: pgUniqueViolation,
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    const err = await caller.auth
      .register({
        email: "race@example.com",
        username: "racer",
        password: "password123",
      })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "CONFLICT" });
    // Must not expose which field — message should be generic
    expect((err as { message: string }).message).toBe("Email or username is already taken");
  });

  it("re-throws non-23505 DB errors from INSERT without wrapping", async () => {
    const dbErr = Object.assign(new Error("connection refused"), { code: "08006" });
    const db = fakeDb({
      selectRows: [],
      insertError: dbErr,
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    await expect(
      caller.auth.register({
        email: "err@example.com",
        username: "erruser",
        password: "password123",
      }),
    ).rejects.toThrow("connection refused");
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

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
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

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    await expect(
      caller.auth.login({
        usernameOrEmail: "carol@example.com",
        password: "wrongpassword",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("throws UNAUTHORIZED when user not found", async () => {
    const db = fakeDb({ selectRows: [] });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    await expect(
      caller.auth.login({
        usernameOrEmail: "nobody@example.com",
        password: "anything",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });
});

// ---------------------------------------------------------------------------
// auth.me
// ---------------------------------------------------------------------------

describe("auth.me", () => {
  it("returns the authenticated principal from a DB read", async () => {
    const db = fakeDb({
      selectRows: [{ id: UUID5, email: "dave@example.com", username: "dave" }],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
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
    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
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
    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
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
      geocode: async () => null,
      stripe: stubStripe,
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
      geocode: async () => null,
      stripe: stubStripe,
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
      geocode: async () => null,
      stripe: stubStripe,
      user: { id: UUID7 },
    };
    const caller = createCaller(ctx);

    const result = await caller.stores.create({ name: "Frank's Veggies" });
    expect(result.id).toBe(STORE_UUID2);
    expect(result.name).toBe("Frank's Veggies");
    expect(result.userId).toBe(UUID7);
  });

  it("throws CONFLICT when the user already has a store (precheck)", async () => {
    const db = fakeDb({
      selectRows: [{ id: STORE_UUID1 }], // already has store
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: { id: UUID7 },
    };
    const caller = createCaller(ctx);

    await expect(caller.stores.create({ name: "Another Store" })).rejects.toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    );
  });

  it("throws CONFLICT when INSERT races and yields a 23505 unique-violation", async () => {
    // Simulate a concurrent duplicate: precheck SELECT finds nothing, but the
    // INSERT itself then throws SQLSTATE 23505 (the race window).
    const pgUniqueViolation = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    const db = fakeDb({
      selectRows: [], // precheck passes
      insertError: pgUniqueViolation,
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: { id: UUID7 },
    };
    const caller = createCaller(ctx);

    const err = await caller.stores.create({ name: "Concurrent Store" }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "CONFLICT" });
    expect((err as { message: string }).message).toBe("You already have a store.");
  });

  it("re-throws non-23505 DB errors from store INSERT without wrapping", async () => {
    const dbErr = Object.assign(new Error("disk full"), { code: "53100" });
    const db = fakeDb({
      selectRows: [],
      insertError: dbErr,
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: { id: UUID7 },
    };
    const caller = createCaller(ctx);

    await expect(caller.stores.create({ name: "Error Store" })).rejects.toThrow("disk full");
  });

  it("throws UNAUTHORIZED when unauthenticated", async () => {
    const db = fakeDb({ selectRows: [] });
    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    await expect(caller.stores.create({ name: "Should Fail" })).rejects.toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });
});

// ---------------------------------------------------------------------------
// stores.get
// ---------------------------------------------------------------------------

describe("stores.get", () => {
  const PUBLIC_STORE_ID = "a2eebc99-9c0b-4ef8-bb6d-6bb9bd380b00";
  const PUBLIC_USER_ID  = "b2eebc99-9c0b-4ef8-bb6d-6bb9bd380b01";

  it("returns public profile (id, name, logo, about) for an existing store", async () => {
    const db = fakeDb({
      selectRows: [
        {
          id: PUBLIC_STORE_ID,
          name: "Green Acres Farm",
          logo: "https://example.com/logo.png",
          about: "Fresh produce daily.",
        },
      ],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    const result = await caller.stores.get({ storeId: PUBLIC_STORE_ID });

    expect(result.id).toBe(PUBLIC_STORE_ID);
    expect(result.name).toBe("Green Acres Farm");
    expect(result.logo).toBe("https://example.com/logo.png");
    expect(result.about).toBe("Fresh produce daily.");

    // Internal fields must NOT be present on the result
    expect(result).not.toHaveProperty("userId");
    expect(result).not.toHaveProperty("stripeConnectAccountId");
  });

  it("coerces null logo and about correctly", async () => {
    const db = fakeDb({
      selectRows: [
        {
          id: PUBLIC_STORE_ID,
          name: "Bare Minimum Farm",
          logo: null,
          about: null,
        },
      ],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    const result = await caller.stores.get({ storeId: PUBLIC_STORE_ID });

    expect(result.logo).toBeNull();
    expect(result.about).toBeNull();
    // Internal fields must NOT be present
    expect(result).not.toHaveProperty("userId");
    expect(result).not.toHaveProperty("stripeConnectAccountId");
  });

  it("throws NOT_FOUND when the store does not exist", async () => {
    const db = fakeDb({ selectRows: [] });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    await expect(
      caller.stores.get({ storeId: PUBLIC_USER_ID }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});

// ---------------------------------------------------------------------------
// Shared listing fixture data
// ---------------------------------------------------------------------------

const LISTING_UUID1 = "d1eebc99-9c0b-4ef8-bb6d-6bb9bd380b11";
const LISTING_STORE_UUID = "e1eebc99-9c0b-4ef8-bb6d-6bb9bd380b22";
const LISTING_USER_UUID = "f1eebc99-9c0b-4ef8-bb6d-6bb9bd380b33";
const NOW_ISO = new Date("2026-01-01T00:00:00.000Z").toISOString();
const NOW_DATE = new Date("2026-01-01T00:00:00.000Z");

const BASE_LISTING = {
  id: LISTING_UUID1,
  storeId: LISTING_STORE_UUID,
  name: "Tomatoes",
  category: "vegetable" as const,
  priceCents: 250,
  quantity: 10,
  unit: "lb" as const,
  attributes: null,
  createdAt: NOW_DATE,
  updatedAt: NOW_DATE,
};

// ---------------------------------------------------------------------------
// listings.create
// ---------------------------------------------------------------------------

describe("listings.create", () => {
  it("happy path: creates a listing for the caller's store", async () => {
    const db = fakeDb({
      selectRows: [{ id: LISTING_STORE_UUID }], // store lookup
      insertRows: [BASE_LISTING],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: { id: LISTING_USER_UUID },
    };
    const caller = createCaller(ctx);

    const result = await caller.listings.create({
      name: "Tomatoes",
      category: "vegetable",
      priceCents: 250,
      quantity: 10,
      unit: "lb",
    });

    expect(result.id).toBe(LISTING_UUID1);
    expect(result.name).toBe("Tomatoes");
    expect(result.category).toBe("vegetable");
    expect(result.priceCents).toBe(250);
    expect(result.storeId).toBe(LISTING_STORE_UUID);
    expect(result.createdAt).toBe(NOW_ISO);
  });

  it("throws NOT_FOUND when the user has no store", async () => {
    const db = fakeDb({ selectRows: [] }); // no store

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: { id: LISTING_USER_UUID },
    };
    const caller = createCaller(ctx);

    await expect(
      caller.listings.create({
        name: "Tomatoes",
        category: "vegetable",
        priceCents: 250,
        quantity: 10,
        unit: "lb",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("throws UNAUTHORIZED when unauthenticated", async () => {
    const db = fakeDb({ selectRows: [] });
    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    await expect(
      caller.listings.create({
        name: "Tomatoes",
        category: "vegetable",
        priceCents: 250,
        quantity: 10,
        unit: "lb",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });
});

// ---------------------------------------------------------------------------
// listings.update
// ---------------------------------------------------------------------------

describe("listings.update", () => {
  it("happy path: updates a listing the caller owns", async () => {
    // joinRows = the listing+store ownership row
    const db = fakeDb({
      joinRows: [
        {
          id: LISTING_UUID1,
          storeId: LISTING_STORE_UUID,
          userId: LISTING_USER_UUID,
        },
      ],
      updateRows: [{ ...BASE_LISTING, name: "Cherry Tomatoes", priceCents: 350 }],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: { id: LISTING_USER_UUID },
    };
    const caller = createCaller(ctx);

    const result = await caller.listings.update({
      listingId: LISTING_UUID1,
      name: "Cherry Tomatoes",
      priceCents: 350,
    });

    expect(result.name).toBe("Cherry Tomatoes");
    expect(result.priceCents).toBe(350);
  });

  it("throws FORBIDDEN when the caller does not own the listing's store", async () => {
    const OTHER_USER = "aa11bc99-9c0b-4ef8-bb6d-6bb9bd380c99";
    const db = fakeDb({
      joinRows: [
        {
          id: LISTING_UUID1,
          storeId: LISTING_STORE_UUID,
          userId: OTHER_USER, // owned by someone else
        },
      ],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: { id: LISTING_USER_UUID },
    };
    const caller = createCaller(ctx);

    await expect(
      caller.listings.update({ listingId: LISTING_UUID1, name: "Hacked" }),
    ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("throws NOT_FOUND when the listing does not exist", async () => {
    const db = fakeDb({ joinRows: [] });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: { id: LISTING_USER_UUID },
    };
    const caller = createCaller(ctx);

    await expect(
      caller.listings.update({ listingId: LISTING_UUID1, name: "Ghost" }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });

  it("throws UNAUTHORIZED when unauthenticated", async () => {
    const db = fakeDb({ joinRows: [] });
    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    await expect(
      caller.listings.update({ listingId: LISTING_UUID1, name: "Ghost" }),
    ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });
});

// ---------------------------------------------------------------------------
// listings.listByStore
// ---------------------------------------------------------------------------

describe("listings.listByStore", () => {
  it("returns an array of listings for a store", async () => {
    const db = fakeDb({
      selectRows: [
        BASE_LISTING,
        { ...BASE_LISTING, id: "bb22bc99-9c0b-4ef8-bb6d-6bb9bd380c11", name: "Basil" },
      ],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    const result = await caller.listings.listByStore({ storeId: LISTING_STORE_UUID });
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe("Tomatoes");
    expect(result[1]?.name).toBe("Basil");
  });

  it("returns an empty array when the store has no listings", async () => {
    const db = fakeDb({ selectRows: [] });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    const result = await caller.listings.listByStore({ storeId: LISTING_STORE_UUID });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// geo.setStoreLocation
// ---------------------------------------------------------------------------

describe("geo.setStoreLocation", () => {
  const STORE_ID = "cc33bc99-9c0b-4ef8-bb6d-6bb9bd380d11";
  const LOCATION_ID = "dd44bc99-9c0b-4ef8-bb6d-6bb9bd380d22";
  const GEO_USER_ID = "ee55bc99-9c0b-4ef8-bb6d-6bb9bd380d33";

  const locationInput = {
    address: "100 Farm Rd",
    city: "Springfield",
    state: "IL",
    zip: "62701",
  };

  it("happy path: geocodes address and upserts location", async () => {
    const db = fakeDb({
      selectRows: [{ id: STORE_ID }], // store lookup
      insertRows: [
        {
          id: LOCATION_ID,
          storeId: STORE_ID,
          address: "100 Farm Rd",
          city: "Springfield",
          state: "IL",
          zip: "62701",
        },
      ],
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => ({ lat: 39.78, lng: -89.65 }),
      stripe: stubStripe,
      user: { id: GEO_USER_ID },
    };
    const caller = createCaller(ctx);

    const result = await caller.geo.setStoreLocation(locationInput);

    expect(result.id).toBe(LOCATION_ID);
    expect(result.storeId).toBe(STORE_ID);
    expect(result.address).toBe("100 Farm Rd");
    expect(result.lat).toBe(39.78);
    expect(result.lng).toBe(-89.65);
  });

  it("throws BAD_REQUEST when geocoder returns null (address not found)", async () => {
    const db = fakeDb({
      selectRows: [{ id: STORE_ID }], // store exists
    });

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null, // bad address
      stripe: stubStripe,
      user: { id: GEO_USER_ID },
    };
    const caller = createCaller(ctx);

    await expect(caller.geo.setStoreLocation(locationInput)).rejects.toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  });

  it("throws NOT_FOUND when the caller has no store", async () => {
    const db = fakeDb({ selectRows: [] }); // no store

    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => ({ lat: 39.78, lng: -89.65 }),
      stripe: stubStripe,
      user: { id: GEO_USER_ID },
    };
    const caller = createCaller(ctx);

    await expect(caller.geo.setStoreLocation(locationInput)).rejects.toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("throws UNAUTHORIZED when unauthenticated", async () => {
    const db = fakeDb({ selectRows: [] });
    const ctx: Context = {
      db,
      jwtSecret: TEST_SECRET,
      auth: stubAuth,
      geocode: async () => null,
      stripe: stubStripe,
      user: null,
    };
    const caller = createCaller(ctx);

    await expect(caller.geo.setStoreLocation(locationInput)).rejects.toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });
});
