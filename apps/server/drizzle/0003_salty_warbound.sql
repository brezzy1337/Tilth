CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."listing_category" AS ENUM('vegetable', 'fruit', 'herb', 'egg', 'honey', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."listing_unit" AS ENUM('each', 'lb', 'oz', 'bunch', 'dozen', 'jar', 'pint', 'quart');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" "listing_category" NOT NULL,
	"price_cents" integer NOT NULL,
	"quantity" integer NOT NULL,
	"unit" "listing_unit" NOT NULL,
	"attributes" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"address" text NOT NULL,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"zip" text NOT NULL,
	"geog" geography(Point,4326) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "locations_store_id_unique" UNIQUE("store_id")
);
--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locations_geog_idx" ON "locations" USING gist ("geog");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listings_store_id_idx" ON "listings" ("store_id");