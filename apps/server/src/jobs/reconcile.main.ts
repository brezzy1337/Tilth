/**
 * Reconciliation job entrypoint.
 *
 * This is the ONLY place in the job that reads `env`, constructs the DB
 * connection, and wires the Stripe client — mirroring the pattern in
 * `src/index.ts` and `src/db/migrate.ts`.
 *
 * Executed by the Cloud Run Job:
 *   node dist/reconcile.mjs
 *
 * Exit codes:
 *   0 — reconcile() returned successfully (individual item errors are logged
 *       but do not cause a non-zero exit; the summary captures them).
 *   1 — a hard failure (e.g. DB connection refused, env validation failed).
 */

import { env } from "../env";
import { db } from "../db/index";
import { createStripeClient } from "../stripe";
import { reconcile } from "./reconcile";

const stripe = createStripeClient(env.STRIPE_SECRET_KEY, {
  refreshUrl: env.STRIPE_CONNECT_REFRESH_URL,
  returnUrl: env.STRIPE_CONNECT_RETURN_URL,
});

try {
  const summary = await reconcile({ db, stripe });
  console.log(JSON.stringify(summary));
  process.exit(0);
} catch (err) {
  console.error(
    "[reconcile.main] fatal error:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}
