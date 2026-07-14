/**
 * Unit tests for the HTTP request-routing logic in createRequestListener.
 *
 * These tests are FAST — no real network, no env vars, no DB, no Stripe SDK.
 * They use minimal fake req/res objects and spy functions to verify:
 *   - /trpc/** prefix is stripped before delegating to trpcHandler
 *   - bare paths (e.g. /health.ping) pass through unchanged (CD smoke-test compat)
 *   - POST /webhooks/stripe is routed to the webhook spy, never to trpcHandler
 *
 * This is the regression guard for the mobile↔server tRPC path fix:
 *   Mobile httpBatchLink base = ${API_URL}/trpc
 *   Server tRPC handler resolves procedures from req.url relative to /
 *   createRequestListener strips the /trpc prefix before delegating so the
 *   handler sees /health.ping (not /trpc/health.ping, which would 404).
 */

import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequestListener } from "./request-listener";

// ---------------------------------------------------------------------------
// Minimal fake req / res helpers
// ---------------------------------------------------------------------------

function fakeReq(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse {
  return {} as unknown as ServerResponse;
}

/** A res double that records writeHead/end calls, for routes that respond directly (not via trpcHandler/webhook spies). */
function recordingRes(): ServerResponse & {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
} {
  const rec = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: "",
    writeHead(status: number, headers?: Record<string, unknown>) {
      rec.statusCode = status;
      rec.headers = headers ?? {};
      return rec;
    },
    end(chunk?: string) {
      rec.body = chunk ?? "";
      return rec;
    },
  };
  return rec as unknown as ServerResponse & {
    statusCode: number;
    headers: Record<string, unknown>;
    body: string;
  };
}

// ---------------------------------------------------------------------------
// Build a listener with spy deps
// ---------------------------------------------------------------------------

type WebhookOpts = Parameters<typeof createRequestListener>[0]["webhook"]["opts"];
type GardenShareDeps = NonNullable<Parameters<typeof createRequestListener>[0]["gardenShare"]>;
type GardenShareHandleOpts = Parameters<GardenShareDeps["handle"]>[2];

function makeListener() {
  // Use explicit function signatures to avoid vi.fn generic issues across vitest versions.
  const trpcSpy = vi.fn((_req: IncomingMessage, _res: ServerResponse) => {});
  const webhookSpy = vi.fn((_req: IncomingMessage, _res: ServerResponse, _opts: WebhookOpts) => {});

  const listener = createRequestListener({
    trpcHandler: trpcSpy,
    webhook: {
      handle: webhookSpy,
      // opts is passed through opaquely; content doesn't matter for routing tests
      opts: {} as WebhookOpts,
    },
  });

  return { listener, trpcSpy, webhookSpy };
}

/** Variant that also wires a `gardenShare` spy — for /garden/{postId} routing tests. */
function makeListenerWithGardenShare() {
  const trpcSpy = vi.fn((_req: IncomingMessage, _res: ServerResponse) => {});
  const webhookSpy = vi.fn((_req: IncomingMessage, _res: ServerResponse, _opts: WebhookOpts) => {});
  const gardenShareSpy = vi.fn(
    (_req: IncomingMessage, _res: ServerResponse, _opts: GardenShareHandleOpts) => {},
  );

  const listener = createRequestListener({
    trpcHandler: trpcSpy,
    webhook: { handle: webhookSpy, opts: {} as WebhookOpts },
    gardenShare: {
      handle: gardenShareSpy,
      opts: {} as Omit<GardenShareHandleOpts, "postId">,
    },
  });

  return { listener, trpcSpy, webhookSpy, gardenShareSpy };
}

// ---------------------------------------------------------------------------
// /trpc prefix stripping
// ---------------------------------------------------------------------------

describe("createRequestListener — /trpc prefix stripping", () => {
  it("strips /trpc prefix: /trpc/health.ping → trpcHandler sees /health.ping", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", "/trpc/health.ping");
    listener(req, fakeRes());

    expect(trpcSpy).toHaveBeenCalledTimes(1);
    // req.url is mutated in-place before the handler is called
    expect(req.url).toBe("/health.ping");
  });

  it("strips /trpc prefix with batch query: /trpc/a.b,c.d?batch=1&input=… → /a.b,c.d?batch=1&input=…", () => {
    const { listener, trpcSpy } = makeListener();
    const url = "/trpc/a.b,c.d?batch=1&input=%7B%220%22%3A%7B%7D%7D";
    const req = fakeReq("GET", url);
    listener(req, fakeRes());

    expect(trpcSpy).toHaveBeenCalledTimes(1);
    expect(req.url).toBe("/a.b,c.d?batch=1&input=%7B%220%22%3A%7B%7D%7D");
  });

  it("handles exactly /trpc (no trailing slash) → trpcHandler sees /", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", "/trpc");
    listener(req, fakeRes());

    expect(trpcSpy).toHaveBeenCalledTimes(1);
    expect(req.url).toBe("/");
  });

  it("handles /trpc/ (trailing slash) → trpcHandler sees /", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", "/trpc/");
    listener(req, fakeRes());

    expect(trpcSpy).toHaveBeenCalledTimes(1);
    expect(req.url).toBe("/");
  });

  it("handles /trpc?querystring → trpcHandler sees ?querystring (with leading /)", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", "/trpc?batch=1");
    listener(req, fakeRes());

    expect(trpcSpy).toHaveBeenCalledTimes(1);
    // /trpc?batch=1 → strip /trpc → ?batch=1, which doesn't start with / → prepend /
    expect(req.url).toBe("/?batch=1");
  });
});

// ---------------------------------------------------------------------------
// Bare / root paths pass through unchanged (CD smoke-test compat)
// ---------------------------------------------------------------------------

describe("createRequestListener — bare root paths pass through unchanged", () => {
  it("bare /health.ping passes through unchanged to trpcHandler", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", "/health.ping");
    listener(req, fakeRes());

    expect(trpcSpy).toHaveBeenCalledTimes(1);
    expect(req.url).toBe("/health.ping");
  });

  it("/ passes through unchanged to trpcHandler", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", "/");
    listener(req, fakeRes());

    expect(trpcSpy).toHaveBeenCalledTimes(1);
    expect(req.url).toBe("/");
  });

  it("a path that contains /trpc in a non-prefix position is not stripped", () => {
    // e.g. /api/trpc/health — should not be stripped (it's not a /trpc-rooted path)
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", "/api/trpc/health");
    listener(req, fakeRes());

    expect(trpcSpy).toHaveBeenCalledTimes(1);
    expect(req.url).toBe("/api/trpc/health");
  });
});

// ---------------------------------------------------------------------------
// Webhook routing
// ---------------------------------------------------------------------------

describe("createRequestListener — webhook routing", () => {
  it("POST /webhooks/stripe routes to the webhook spy and does NOT call trpcHandler", () => {
    const { listener, trpcSpy, webhookSpy } = makeListener();
    const req = fakeReq("POST", "/webhooks/stripe");
    listener(req, fakeRes());

    expect(webhookSpy).toHaveBeenCalledTimes(1);
    expect(trpcSpy).not.toHaveBeenCalled();
  });

  it("GET /webhooks/stripe (wrong method) falls through to trpcHandler", () => {
    const { listener, trpcSpy, webhookSpy } = makeListener();
    const req = fakeReq("GET", "/webhooks/stripe");
    listener(req, fakeRes());

    // Method does not match; falls through to tRPC (which will 404 or handle it)
    expect(webhookSpy).not.toHaveBeenCalled();
    expect(trpcSpy).toHaveBeenCalledTimes(1);
  });

  it("POST /webhooks/stripe/other (longer path) falls through to trpcHandler", () => {
    const { listener, trpcSpy, webhookSpy } = makeListener();
    const req = fakeReq("POST", "/webhooks/stripe/other");
    listener(req, fakeRes());

    expect(webhookSpy).not.toHaveBeenCalled();
    expect(trpcSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Public legal pages (F-052)
// ---------------------------------------------------------------------------

describe("createRequestListener — public legal pages", () => {
  it("GET /legal/terms returns 200 text/html with the ToS title and the 10% platform fee phrase", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", "/legal/terms");
    const res = recordingRes();
    listener(req, res);

    expect(trpcSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["Cache-Control"]).toBe("public, max-age=3600");
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(res.body).toContain("Terms of Service");
    expect(res.body).toContain("10%");
  });

  it("GET /legal/privacy returns 200 text/html with the Privacy Policy title and the 30-day grace phrase", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", "/legal/privacy");
    const res = recordingRes();
    listener(req, res);

    expect(trpcSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["Cache-Control"]).toBe("public, max-age=3600");
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(res.body).toContain("Privacy Policy");
    expect(res.body).toContain("30-day grace");
  });

  it("POST /legal/terms → 405, does not call trpcHandler", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("POST", "/legal/terms");
    const res = recordingRes();
    listener(req, res);

    expect(trpcSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(405);
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("POST /legal/privacy → 405, does not call trpcHandler", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("POST", "/legal/privacy");
    const res = recordingRes();
    listener(req, res);

    expect(trpcSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(405);
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("unknown /legal/x is not handled here — falls through to trpcHandler (existing 404 fallback)", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", "/legal/x");
    listener(req, fakeRes());

    expect(trpcSpy).toHaveBeenCalledTimes(1);
    // Not rewritten like /trpc paths — passed through as-is for tRPC to 404.
    expect(req.url).toBe("/legal/x");
  });

  it("GET /legal/terms?utm_source=app-store still matches (query string ignored for routing)", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", "/legal/terms?utm_source=app-store");
    const res = recordingRes();
    listener(req, res);

    expect(trpcSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Public garden share page (F-053)
// ---------------------------------------------------------------------------

describe("createRequestListener — /garden/{postId} share page routing", () => {
  const UUID_POST = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33";

  it("GET /garden/{postId} routes to the gardenShare spy, not trpcHandler", () => {
    const { listener, trpcSpy, gardenShareSpy } = makeListenerWithGardenShare();
    const req = fakeReq("GET", `/garden/${UUID_POST}`);
    listener(req, fakeRes());

    expect(gardenShareSpy).toHaveBeenCalledTimes(1);
    expect(trpcSpy).not.toHaveBeenCalled();
    const [, , opts] = gardenShareSpy.mock.calls[0]!;
    expect(opts.postId).toBe(UUID_POST);
  });

  it("query strings are ignored for routing: GET /garden/{postId}?utm_source=x still matches", () => {
    const { listener, gardenShareSpy } = makeListenerWithGardenShare();
    const req = fakeReq("GET", `/garden/${UUID_POST}?utm_source=x`);
    listener(req, fakeRes());

    expect(gardenShareSpy).toHaveBeenCalledTimes(1);
    const [, , opts] = gardenShareSpy.mock.calls[0]!;
    expect(opts.postId).toBe(UUID_POST);
  });

  it("POST /garden/{postId} → 405, does not call gardenShare or trpcHandler", () => {
    const { listener, trpcSpy, gardenShareSpy } = makeListenerWithGardenShare();
    const req = fakeReq("POST", `/garden/${UUID_POST}`);
    const res = recordingRes();
    listener(req, res);

    expect(gardenShareSpy).not.toHaveBeenCalled();
    expect(trpcSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(405);
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("a malformed (non-UUID) postId segment still routes to gardenShare (validation happens downstream)", () => {
    const { listener, gardenShareSpy } = makeListenerWithGardenShare();
    const req = fakeReq("GET", "/garden/not-a-uuid");
    listener(req, fakeRes());

    expect(gardenShareSpy).toHaveBeenCalledTimes(1);
    const [, , opts] = gardenShareSpy.mock.calls[0]!;
    expect(opts.postId).toBe("not-a-uuid");
  });

  it("without a wired gardenShare dep, GET /garden/{postId} falls through to trpcHandler unchanged (existing callers/tests unaffected)", () => {
    const { listener, trpcSpy } = makeListener();
    const req = fakeReq("GET", `/garden/${UUID_POST}`);
    listener(req, fakeRes());

    expect(trpcSpy).toHaveBeenCalledTimes(1);
    expect(req.url).toBe(`/garden/${UUID_POST}`);
  });

  it("/garden (no postId segment) is not matched — falls through to trpcHandler", () => {
    const { listener, trpcSpy, gardenShareSpy } = makeListenerWithGardenShare();
    const req = fakeReq("GET", "/garden");
    listener(req, fakeRes());

    expect(gardenShareSpy).not.toHaveBeenCalled();
    expect(trpcSpy).toHaveBeenCalledTimes(1);
  });

  it("/garden/{postId}/extra (longer path) is not matched — falls through to trpcHandler", () => {
    const { listener, trpcSpy, gardenShareSpy } = makeListenerWithGardenShare();
    const req = fakeReq("GET", `/garden/${UUID_POST}/extra`);
    listener(req, fakeRes());

    expect(gardenShareSpy).not.toHaveBeenCalled();
    expect(trpcSpy).toHaveBeenCalledTimes(1);
  });
});
