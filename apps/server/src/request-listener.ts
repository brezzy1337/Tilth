/**
 * HTTP request-listener factory — side-effect-free, dependency-injected.
 *
 * Extracted from index.ts so it can be unit-tested without importing env,
 * db, or stripe (all of which have module-load side-effects incompatible with
 * the test environment).
 *
 * Routing decisions:
 *   POST /webhooks/stripe  →  raw-body Stripe webhook handler (must stay first)
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

export type TrpcHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface WebhookDeps {
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    opts: Parameters<typeof handleStripeWebhookRequest>[2],
  ) => void;
  opts: Parameters<typeof handleStripeWebhookRequest>[2];
}

export function createRequestListener(deps: {
  trpcHandler: TrpcHandler;
  webhook: WebhookDeps;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // Webhook must be checked first — it needs the raw body before any parsing.
    if (req.method === "POST" && req.url === "/webhooks/stripe") {
      return deps.webhook.handle(req, res, deps.webhook.opts);
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
