/**
 * AppRouter — the single exported contract that mobile consumes type-only.
 *
 * Import path for the mobile tRPC client:
 *   import type { AppRouter } from "@homegrown/server/src/router"
 *   (or via the workspace package once an `exports` entry is added)
 *
 * Add new sub-routers here as they land in later milestones.
 */

import { router } from "./trpc";
import { healthRouter } from "./routers/health";
import { authRouter } from "./routers/auth";
import { storesRouter } from "./routers/stores";
import { geoRouter } from "./routers/geo";
import { listingsRouter } from "./routers/listings";
import { ordersRouter } from "./routers/orders";
import { connectRouter } from "./routers/connect";

export const appRouter = router({
  health: healthRouter,
  auth: authRouter,
  stores: storesRouter,
  geo: geoRouter,
  listings: listingsRouter,
  orders: ordersRouter,
  connect: connectRouter,
});

/** The type that mobile's tRPC client is parameterised with. */
export type AppRouter = typeof appRouter;
