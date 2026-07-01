CREATE TYPE "public"."order_preparation_state" AS ENUM('packing', 'ready');--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "preparation_state" "order_preparation_state";