/**
 * Drizzle DB client.
 *
 * This module imports `env` (and therefore triggers env validation + exits on
 * missing vars). Keep it out of the router import tree so tests can import
 * routers without a DATABASE_URL being set.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import { dbConnection } from "./parse-database-url";
import * as schema from "./schema";

const conn = dbConnection(env.DATABASE_URL);
const queryClient =
  typeof conn === "string" ? postgres(conn) : postgres(conn as postgres.Options<Record<string, postgres.PostgresType>>);

export const db = drizzle(queryClient, { schema });
