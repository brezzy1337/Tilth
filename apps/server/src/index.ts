/**
 * HomeGrown API — tRPC modular monolith entrypoint.
 *
 * Listens on `env.PORT` (Cloud Run injects PORT; defaults to 3001 locally).
 * This file is the ONLY place that imports `env`, `db`, and `auth` — everything
 * else in the router tree receives them via context injection, keeping the router
 * import tree side-effect free (no env validation, no DB connection on import,
 * and no node:crypto that would break mobile's typecheck).
 */

import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { env } from "./env";
import { db } from "./db/index";
import { appRouter } from "./router";
import { createContext } from "./context";
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
} from "./auth";

const server = createHTTPServer({
  router: appRouter,
  createContext: (opts) =>
    createContext(opts, {
      db,
      jwtSecret: env.JWT_SECRET,
      auth: { hashPassword, verifyPassword, signToken, verifyToken },
    }),
});

server.listen(env.PORT, () => {
  console.log(`HomeGrown server listening on http://localhost:${env.PORT}`);
});
