CREATE TABLE "org_domains" (
	"arena_id" uuid PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"challenge_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "org_domains" ADD CONSTRAINT "org_domains_arena_id_arenas_id_fk" FOREIGN KEY ("arena_id") REFERENCES "public"."arenas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_domains_verified_idx" ON "org_domains" USING btree ("domain") WHERE "org_domains"."verified_at" is not null;