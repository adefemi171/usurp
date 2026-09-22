CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"budget_micros" integer,
	"max_agent_runs" integer,
	"advice_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"outcome" text DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "missions_user_created_idx" ON "missions" USING btree ("user_id","created_at");