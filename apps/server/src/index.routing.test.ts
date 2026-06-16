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

// ---------------------------------------------------------------------------
// Build a listener with spy deps
// ---------------------------------------------------------------------------

type WebhookOpts = Parameters<typeof createRequestListener>[0]["webhook"]["opts"];

function makeListener() {
  // Use explicit function signatures to avoid vi.fn generic issues across vitest versions.
  const trpcSpy = vi.fn((_req: IncomingMessage, _res: ServerResponse) => {});
  const webhookSpy = vi.fn(
    (_req: IncomingMessage, _res: ServerResponse, _opts: WebhookOpts) => {},
  );

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
