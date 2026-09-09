CREATE TABLE "efficiency_feedback" (
	"user_id" uuid NOT NULL,
	"recommendation" text NOT NULL,
	"response" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "efficiency_feedback_user_id_recommendation_pk" PRIMARY KEY("user_id","recommendation")
);
--> statement-breakpoint
ALTER TABLE "efficiency_feedback" ADD CONSTRAINT "efficiency_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "efficiency_feedback_user_idx" ON "efficiency_feedback" USING btree ("user_id");