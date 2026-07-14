/**
 * HTTP request-listener factory — side-effect-free, dependency-injected.
 *
 * Extracted from index.ts so it can be unit-tested without importing env,
 * db, or stripe (all of which have module-load side-effects incompatible with
 * the test environment).
 *
 * Routing decisions:
 *   POST /webhooks/stripe  →  raw-body Stripe webhook handler (must stay first)
 *   POST /webhooks/mux     →  raw-body Mux webhook handler (F-047; must also stay
 *                              first — optional dep, only wired when the caller
 *                              supplies `webhookMux`, so existing callers/tests
 *                              that omit it are unaffected)
 *   GET  /legal/terms      →  public Terms of Service HTML page (F-052, no auth)
 *   GET  /legal/privacy    →  public Privacy Policy HTML page (F-052, no auth)
 *                              Non-GET on either path → 405. These are static,
 *                              server-rendered pages so App Store Connect /
 *                              Play Console metadata has real URLs to link to.
 *   GET  /garden/{postId}  →  public per-post garden share page (F-053, no auth).
 *                              UNLIKE /legal/*, this hits the DB per-request
 *                              (dynamic content keyed by postId) — see
 *                              garden-share-html.ts. Non-GET → 405. Only
 *                              wired when the caller supplies `gardenShare`
 *                              (optional, same pattern as `webhookMux`).
 *   /trpc/**               →  tRPC handler after stripping the /trpc prefix
 *                              (canonical path; matches mobile client's httpBatchLink base)
 *   /**                    →  tRPC handler, path unchanged
 *                              (root paths accepted for CD smoke tests, e.g. /health.ping)
 *
 * tRPC prefix-strip rules:
 *   /trpc/health.ping               → /health.ping
 *   /trpc/a.b,c.d?batch=1&input=…  → /a.b,c.d?batch=1&input=…
 *   /trpc  (exact)                  → /
 *   /trpc/                          → /
 *   /trpc?querystring               → /?querystring
 *   /health.ping (no prefix)        → /health.ping  (unchanged)
 *
 * The strip is a path-segment match — only a leading `/trpc` segment is
 * removed, never a substring embedded deeper in the URL.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { handleStripeWebhookRequest } from "./webhook";
import type { handleMuxWebhookRequest } from "./webhook-mux";
import type { handleGardenShareRequest } from "./garden-share-html";
import { TERMS_OF_SERVICE, PRIVACY_POLICY } from "@homegrown/shared";
import { renderLegalHtml } from "./legal-html";

/** Matches `/garden/<postId>` exactly — the postId segment itself is validated (as a UUID) downstream. */
const GARDEN_SHARE_PATH_RE = /^\/garden\/([^/]+)$/;

const LEGAL_PAGES: Record<string, string> = {
  "/legal/terms": renderLegalHtml(TERMS_OF_SERVICE),
  "/legal/privacy": renderLegalHtml(PRIVACY_POLICY),
};

export type TrpcHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface WebhookDeps {
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: Parameters<typeof handleStripeWebhookRequest>[2],
  ) => void;
  opts: Parameters<typeof handleStripeWebhookRequest>[2];
}

/** Mux webhook wiring (F-047) — analogous to WebhookDeps but for /webhooks/mux. */
export interface WebhookMuxDeps {
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: Parameters<typeof handleMuxWebhookRequest>[2],
  ) => void;
  opts: Parameters<typeof handleMuxWebhookRequest>[2];
}

/**
 * Public garden share page wiring (F-053) — analogous to WebhookDeps, but for
 * GET /garden/{postId}. `opts` carries only the fixed dependency (`db`); the
 * per-request `postId` is merged in by this listener (see below) from the
 * matched path segment, mirroring how webhook opts stay fixed across calls.
 */
export interface GardenShareDeps {
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: Parameters<typeof handleGardenShareRequest>[2],
  ) => void;
  opts: Omit<Parameters<typeof handleGardenShareRequest>[2], "postId">;
}

export function createRequestListener(deps: {
  trpcHandler: TrpcHandler;
  webhook: WebhookDeps;
  /** Optional so existing callers/tests that don't wire Mux keep working unchanged. */
  webhookMux?: WebhookMuxDeps;
  /** Optional so existing callers/tests that don't wire the garden share page keep working unchanged. */
  gardenShare?: GardenShareDeps;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // Webhooks must be checked first — they need the raw body before any parsing.
    if (req.method === "POST" && req.url === "/webhooks/stripe") {
      return deps.webhook.handle(req, res, deps.webhook.opts);
    }

    if (req.method === "POST" && req.url === "/webhooks/mux" && deps.webhookMux) {
      return deps.webhookMux.handle(req, res, deps.webhookMux.opts);
    }

    // Public legal pages (F-052) — no auth, static server-rendered HTML.
    // Only exact matches on /legal/terms and /legal/privacy are handled here;
    // anything else under /legal/** (e.g. /legal/x) falls through to the tRPC
    // handler, which 404s it like any other unrecognized path.
    const legalPath = req.url?.split("?")[0];
    if (legalPath !== undefined && Object.prototype.hasOwnProperty.call(LEGAL_PAGES, legalPath)) {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET" });
        res.end("Method Not Allowed");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      });
      res.end(LEGAL_PAGES[legalPath]);
      return;
    }

    // Public per-post garden share page (F-053) — dynamic (DB-backed), unlike
    // /legal/* above. Only intercepted when the caller wired `gardenShare`;
    // existing callers/tests that omit it fall through to tRPC unchanged.
    const gardenShareMatch = legalPath !== undefined ? legalPath.match(GARDEN_SHARE_PATH_RE) : null;
    if (gardenShareMatch && deps.gardenShare) {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET" });
        res.end("Method Not Allowed");
        return;
      }

      return deps.gardenShare.handle(req, res, {
        ...deps.gardenShare.opts,
        postId: gardenShareMatch[1]!,
      });
    }

    // Strip the canonical `/trpc` path prefix when present so that the tRPC
    // standalone handler (which resolves procedure names from req.url) sees the
    // bare procedure path rather than /trpc/procedure.name.
    //
    // Only strip when the URL is exactly "/trpc", starts with "/trpc/", or
    // starts with "/trpc?" — preventing accidental stripping of paths like
    // /api/trpc/... that embed the word "trpc" in a non-prefix position.
    const url = req.url ?? "/";
    if (url === "/trpc" || url.startsWith("/trpc/") || url.startsWith("/trpc?")) {
      const stripped = url.slice("/trpc".length) || "/";
      req.url = stripped.startsWith("/") ? stripped : `/${stripped}`;
    }

    return deps.trpcHandler(req, res);
  };
}
