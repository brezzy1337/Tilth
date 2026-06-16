/**
 * HomeGrown API — tRPC modular monolith entrypoint.
 *
 * Listens on `env.PORT` (Cloud Run injects PORT; defaults to 3001 locally).
 * This file is the ONLY place that imports `env`, `db`, `auth`, and `stripe` —
 * everything else in the router tree receives them via context injection, keeping
 * the router import tree side-effect free (no env validation, no DB connection on
 * import, and no node:crypto / Stripe SDK that would break mobile's typecheck).
 *
 * HTTP routing:
 *   POST /webhooks/stripe  →  raw-body Stripe webhook handler (outside tRPC)
 *   everything else        →  tRPC standalone adapter
 */

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { createServer } from "node:http";
import { env } from "./env";
import { db } from "./db/index";
import { appRouter } from "./router";
import { createContext } from "./context";
import { hashPassword, verifyPassword, signToken, verifyToken } from "./auth";
import { geocodeAddress } from "./geocode";
import { createStripeClient } from "./stripe";
import { handleStripeWebhookRequest } from "./webhook";

const stripe = createStripeClient(env.STRIPE_SECRET_KEY);

const trpcHandler = createHTTPHandler({
  router: appRouter,
  createContext: (opts) =>
    createContext(opts, {
      db,
      jwtSecret: env.JWT_SECRET,
      auth: { hashPassword, verifyPassword, signToken, verifyToken },
      geocode: (input) => geocodeAddress(input, env.GOOGLE_GEOCODING_API_KEY),
      stripe,
    }),
});

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/webhooks/stripe") {
    return handleStripeWebhookRequest(req, res, {
      db,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      constructWebhookEvent: (rawBody, sig, secret) =>
        stripe.constructWebhookEvent(rawBody, sig, secret),
    });
  }
  return trpcHandler(req, res);
});

server.listen(env.PORT, () => {
  console.log(`HomeGrown server listening on http://localhost:${env.PORT}`);
});
