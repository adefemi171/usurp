ALTER TABLE "standings" ADD COLUMN "duel_pts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "duels_settlement_idx" ON "duels" USING btree ("state","window_end");--> statement-breakpoint
CREATE INDEX "duels_arena_idx" ON "duels" USING btree ("arena_id");