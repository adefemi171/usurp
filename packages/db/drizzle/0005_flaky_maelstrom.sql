CREATE TABLE "usage_repair_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rows" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "usage_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_repair_backups" ADD CONSTRAINT "usage_repair_backups_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;