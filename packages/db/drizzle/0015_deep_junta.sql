CREATE TABLE "outcome_attestors" (
	"public_key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"share" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcome_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"mission_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outcome_attestors" ADD CONSTRAINT "outcome_attestors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_receipts" ADD CONSTRAINT "outcome_receipts_public_key_outcome_attestors_public_key_fk" FOREIGN KEY ("public_key") REFERENCES "public"."outcome_attestors"("public_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outcome_receipts_key_mission_idx" ON "outcome_receipts" USING btree ("public_key","mission_id");