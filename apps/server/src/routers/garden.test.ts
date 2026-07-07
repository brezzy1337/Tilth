/**
 * Unit tests for the garden router (F-047).
 *
 * No real DB, no real GCS/Mux — uses fake db builders and stub MediaClient /
 * MuxClient injected via ctx (per the DI pattern in context.ts).
 *
 * Covers:
 *   - garden.createVideo: throws PRECONDITION_FAILED when ctx.mux is null (Mux
 *     credentials unset) — the graceful-degradation contract from the F-047 brief.
 *   - garden.createPhotoUploadUrls: throws PRECONDITION_FAILED when ctx.media is
 *     null (GCS_MEDIA_BUCKET unset).
 *   - garden.createPhotoSet: rejects a photo URL that doesn't match the
 *     configured bucket's public URL prefix; accepts one that does; skips the
 *     check entirely when ctx.media is null.
 *   - garden.createVideo happy path: passthrough = new post id; returns
 *     { postId, uploadUrl }.
 *   - garden.createVideo Mux failure: deletes the post row and throws.
 *   - garden.createPhotoUploadUrls happy path: derives the correct file
 *     extension per contentType and returns one entry per `count`.
 *
 * The PostGIS-backed `garden.feed` integration test lives in
 * `garden.feed.integration.test.ts` (guarded on TEST_DATABASE_URL, same pattern
 * as nearby.integration.test.ts).
 */

import { describe, it, expect, vi } from "vitest";
import { appRouter } from "../router";
import { createCallerFactory } from "../trpc";
import type { Context, MediaClient, MuxClient } from "../context";
import * as authHelpers from "../auth";

const createCaller = createCallerFactory(appRouter);

const TEST_SECRET = "test-jwt-secret-that-is-at-least-32-chars";
const UUID_USER = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const UUID_STORE = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22";
const UUID_POST = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33";

const stubAuth: Context["auth"] = {
  hashPassword: authHelpers.hashPassword,
  verifyPassword: authHelpers.verifyPassword,
  signToken: authHelpers.signToken,
  verifyToken: authHelpers.verifyToken,
};

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
// Fake DB builder — select (store lookup), insert (post create), update, delete
// ---------------------------------------------------------------------------

function fakeGardenDb(opts: {
  storeRow?: { id: string };
  insertRows?: unknown[];
  onDelete?: () => void;
  onUpdate?: (set: unknown) => void;
}) {
  const selectBuilder = {
    from: () => selectBuilder,
    where: () => selectBuilder,
    limit: () => Promise.resolve(opts.storeRow ? [opts.storeRow] : []),
  };

  const insertBuilder = {
    values: () => insertBuilder,
    returning: () => Promise.resolve(opts.insertRows ?? []),
  };

  const updateBuilder = {
    set: (s: unknown) => {
      opts.onUpdate?.(s);
      return updateBuilder;
    },
    where: () => Promise.resolve(undefined),
  };

  const deleteBuilder = {
    where: () => {
      opts.onDelete?.();
      return Promise.resolve(undefined);
    },
  };

  return {
    select: () => selectBuilder,
    insert: () => insertBuilder,
    update: () => updateBuilder,
    delete: () => deleteBuilder,
  } as unknown as Context["db"];
}

function makeCtx(overrides: Partial<Context> = {}): Context {
  return {
    db: fakeGardenDb({ storeRow: { id: UUID_STORE } }),
    jwtSecret: TEST_SECRET,
    auth: stubAuth,
    geocode: async () => null,
    stripe: stubStripe,
    media: null,
    mux: null,
    user: { id: UUID_USER },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// garden.createVideo — env-unset graceful degradation
// ---------------------------------------------------------------------------

describe("garden.createVideo — Mux not configured", () => {
  it("throws PRECONDITION_FAILED when ctx.mux is null", async () => {
    const caller = createCaller(makeCtx({ mux: null }));

    await expect(caller.garden.createVideo({ caption: "My garden" })).rejects.toThrow(
      expect.objectContaining({ code: "PRECONDITION_FAILED" }),
    );
  });

  it("does not touch the DB when Mux is not configured", async () => {
    let dbTouched = false;
    const db = new Proxy(
      {},
      {
        get() {
          dbTouched = true;
          return () => {
            throw new Error("should not be called");
          };
        },
      },
    ) as unknown as Context["db"];

    const caller = createCaller(makeCtx({ db, mux: null }));

    await expect(caller.garden.createVideo({ caption: "My garden" })).rejects.toThrow(
      expect.objectContaining({ code: "PRECONDITION_FAILED" }),
    );
    expect(dbTouched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// garden.createVideo — happy path + Mux failure
// ---------------------------------------------------------------------------

describe("garden.createVideo — with Mux configured", () => {
  it("happy path: creates the post, calls Mux with passthrough=postId, returns postId+uploadUrl", async () => {
    const createUpload = vi.fn(async (input: { passthrough: string }) => {
      expect(input.passthrough).toBe(UUID_POST);
      return { uploadId: "mux_upload_123", uploadUrl: "https://storage.mux.com/upload/abc" };
    });
    const mux: MuxClient = { createUpload };

    const db = fakeGardenDb({
      storeRow: { id: UUID_STORE },
      insertRows: [{ id: UUID_POST }],
    });

    const caller = createCaller(makeCtx({ db, mux }));

    const result = await caller.garden.createVideo({ caption: "Tomato time", durationS: 30 });

    expect(result).toEqual({ postId: UUID_POST, uploadUrl: "https://storage.mux.com/upload/abc" });
    expect(createUpload).toHaveBeenCalledTimes(1);
  });

  it("on Mux failure: deletes the post row and throws", async () => {
    const mux: MuxClient = {
      createUpload: vi.fn(async () => {
        throw new Error("Mux is down");
      }),
    };

    let deleted = false;
    const db = fakeGardenDb({
      storeRow: { id: UUID_STORE },
      insertRows: [{ id: UUID_POST }],
      onDelete: () => {
        deleted = true;
      },
    });

    const caller = createCaller(makeCtx({ db, mux }));

    await expect(caller.garden.createVideo({ caption: "Oops" })).rejects.toThrow(
      expect.objectContaining({ code: "INTERNAL_SERVER_ERROR" }),
    );
    expect(deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// garden.createPhotoUploadUrls — env-unset graceful degradation
// ---------------------------------------------------------------------------

describe("garden.createPhotoUploadUrls — GCS not configured", () => {
  it("throws PRECONDITION_FAILED when ctx.media is null", async () => {
    const caller = createCaller(makeCtx({ media: null }));

    await expect(
      caller.garden.createPhotoUploadUrls({ count: 2, contentType: "image/jpeg" }),
    ).rejects.toThrow(expect.objectContaining({ code: "PRECONDITION_FAILED" }));
  });
});

// ---------------------------------------------------------------------------
// garden.createPhotoUploadUrls — happy path
// ---------------------------------------------------------------------------

describe("garden.createPhotoUploadUrls — with GCS configured", () => {
  it("returns one signed URL pair per `count`, with the correct extension for contentType", async () => {
    const createUploadUrl = vi.fn(async (input: { key: string; contentType: string }) => ({
      uploadUrl: `https://signed.example/${input.key}`,
      publicUrl: `https://storage.googleapis.com/my-bucket/${input.key}`,
    }));
    const media: MediaClient = { bucket: "my-bucket", createUploadUrl };

    const caller = createCaller(makeCtx({ media }));

    const result = await caller.garden.createPhotoUploadUrls({ count: 3, contentType: "image/png" });

    expect(result).toHaveLength(3);
    expect(createUploadUrl).toHaveBeenCalledTimes(3);
    for (const call of createUploadUrl.mock.calls) {
      const [input] = call as [{ key: string; contentType: string }];
      expect(input.contentType).toBe("image/png");
      expect(input.key).toMatch(new RegExp(`^garden/${UUID_STORE}/.+\\.png$`));
    }
  });
});

// ---------------------------------------------------------------------------
// garden.createPhotoSet — bucket URL validation
// ---------------------------------------------------------------------------

describe("garden.createPhotoSet — bucket URL validation", () => {
  const media: MediaClient = {
    bucket: "my-bucket",
    createUploadUrl: async () => {
      throw new Error("not used in this test");
    },
  };

  it("rejects a photo URL that does not point at the configured bucket", async () => {
    const db = fakeGardenDb({ storeRow: { id: UUID_STORE }, insertRows: [] });
    const caller = createCaller(makeCtx({ db, media }));

    await expect(
      caller.garden.createPhotoSet({
        caption: "Bad photo",
        photos: [{ url: "https://evil.example.com/photo.jpg" }],
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  it("accepts a photo URL that points at the configured bucket", async () => {
    const db = fakeGardenDb({
      storeRow: { id: UUID_STORE },
      insertRows: [
        {
          id: UUID_POST,
          storeId: UUID_STORE,
          type: "photo_set",
          status: "ready",
          caption: "Good photo",
          photos: [{ url: "https://storage.googleapis.com/my-bucket/garden/x.jpg" }],
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });
    const caller = createCaller(makeCtx({ db, media }));

    const result = await caller.garden.createPhotoSet({
      caption: "Good photo",
      photos: [{ url: "https://storage.googleapis.com/my-bucket/garden/x.jpg" }],
    });

    expect(result.id).toBe(UUID_POST);
    expect(result.photos).toEqual([{ url: "https://storage.googleapis.com/my-bucket/garden/x.jpg" }]);
  });

  it("skips the bucket check entirely when ctx.media is null", async () => {
    const db = fakeGardenDb({
      storeRow: { id: UUID_STORE },
      insertRows: [
        {
          id: UUID_POST,
          storeId: UUID_STORE,
          type: "photo_set",
          status: "ready",
          caption: "Any photo",
          photos: [{ url: "https://anywhere.example.com/photo.jpg" }],
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });
    const caller = createCaller(makeCtx({ db, media: null }));

    const result = await caller.garden.createPhotoSet({
      caption: "Any photo",
      photos: [{ url: "https://anywhere.example.com/photo.jpg" }],
    });

    expect(result.id).toBe(UUID_POST);
  });
});

// ---------------------------------------------------------------------------
// UNAUTHORIZED guard (protectedProcedure)
// ---------------------------------------------------------------------------

describe("garden router — protectedProcedure guard", () => {
  it("createVideo throws UNAUTHORIZED when unauthenticated", async () => {
    const caller = createCaller(makeCtx({ user: null }));

    await expect(caller.garden.createVideo({ caption: "x" })).rejects.toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });

  it("createPhotoSet throws UNAUTHORIZED when unauthenticated", async () => {
    const caller = createCaller(makeCtx({ user: null }));

    await expect(
      caller.garden.createPhotoSet({ caption: "x", photos: [{ url: "https://example.com/a.jpg" }] }),
    ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });

  it("createPhotoUploadUrls throws UNAUTHORIZED when unauthenticated", async () => {
    const caller = createCaller(makeCtx({ user: null }));

    await expect(
      caller.garden.createPhotoUploadUrls({ count: 1, contentType: "image/jpeg" }),
    ).rejects.toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });
});
