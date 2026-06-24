CREATE TYPE "public"."order_fulfillment_method" AS ENUM('pickup', 'delivery');--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfillment_method" "order_fulfillment_method" DEFAULT 'pickup' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_address" text;