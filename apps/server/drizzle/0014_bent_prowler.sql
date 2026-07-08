CREATE TABLE "community_places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"location" geography(Point,4326) NOT NULL,
	"address" text,
	"website" text,
	"hours_text" text,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "community_places_location_idx" ON "community_places" USING gist ("location");--> statement-breakpoint
CREATE UNIQUE INDEX "community_places_source_source_ref_key" ON "community_places" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "community_places_status_idx" ON "community_places" USING btree ("status");