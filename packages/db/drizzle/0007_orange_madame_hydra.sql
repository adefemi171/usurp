CREATE TABLE "device_pairings" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"public_key" text NOT NULL,
	"label" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	"decision" text,
	"device_id" text,
	CONSTRAINT "device_pairings_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_pairings_expiry_idx" ON "device_pairings" USING btree ("expires_at");