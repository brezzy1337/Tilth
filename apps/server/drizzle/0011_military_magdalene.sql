CREATE TYPE "public"."garden_post_status" AS ENUM('processing', 'ready', 'errored');--> statement-breakpoint
CREATE TYPE "public"."garden_post_type" AS ENUM('photo_set', 'video');--> statement-breakpoint
CREATE TABLE "garden_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"type" "garden_post_type" NOT NULL,
	"status" "garden_post_status" DEFAULT 'processing' NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"photos" jsonb,
	"mux_upload_id" text,
	"mux_asset_id" text,
	"mux_playback_id" text,
	"duration_s" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_mux_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "garden_posts" ADD CONSTRAINT "garden_posts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "garden_posts_store_id_idx" ON "garden_posts" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "garden_posts_created_at_id_idx" ON "garden_posts" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);