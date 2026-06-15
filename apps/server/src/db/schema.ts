/**
 * Drizzle schema — Milestone 2: Identity & Store.
 *
 * `users` gains authentication columns (username, passwordHash, stripeCustomerId).
 * `stores` table is added as a 1:1 per user for the pilot.
 *
 * DO NOT add geo/PostGIS columns until the PostGIS migration is scaffolded (M3).
 * Stripe Connect onboarding is OUT OF SCOPE for M2 — the nullable
 * `stripeConnectAccountId` column is carried here for schema continuity only;
 * no Stripe logic is wired until a later milestone.
 */

import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique().notNull(),
  username: text("username").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const stores = pgTable("stores", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  name: text("name").notNull(),
  logo: text("logo"),
  about: text("about"),
  stripeConnectAccountId: text("stripe_connect_account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
