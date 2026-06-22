ALTER TYPE "public"."order_status" ADD VALUE 'disputed';--> statement-breakpoint
CREATE TABLE "processed_stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "amount_owed_cents" integer DEFAULT 0 NOT NULL;