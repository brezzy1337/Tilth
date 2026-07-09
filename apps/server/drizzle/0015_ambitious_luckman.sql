CREATE TABLE "sourcing_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"direction" text NOT NULL,
	"place_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"produce" text NOT NULL,
	"quantity" text NOT NULL,
	"needed_by" date,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community_places" ADD COLUMN "linked_user_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sourcing_request_id" uuid;--> statement-breakpoint
ALTER TABLE "sourcing_requests" ADD CONSTRAINT "sourcing_requests_place_id_community_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."community_places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_requests" ADD CONSTRAINT "sourcing_requests_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_requests" ADD CONSTRAINT "sourcing_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_requests" ADD CONSTRAINT "sourcing_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sourcing_requests_store_id_created_at_idx" ON "sourcing_requests" USING btree ("store_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sourcing_requests_place_id_created_at_idx" ON "sourcing_requests" USING btree ("place_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sourcing_requests_conversation_id_idx" ON "sourcing_requests" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "community_places" ADD CONSTRAINT "community_places_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sourcing_request_id_sourcing_requests_id_fk" FOREIGN KEY ("sourcing_request_id") REFERENCES "public"."sourcing_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_places" ADD CONSTRAINT "community_places_linked_user_id_unique" UNIQUE("linked_user_id");