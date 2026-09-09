CREATE TABLE "usage_bridge_snapshots" (
	"device_id" text PRIMARY KEY NOT NULL,
	"snapshot" jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_bridge_snapshots" ADD CONSTRAINT "usage_bridge_snapshots_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;