ALTER TABLE `component` ADD `lockfile_digest` text;--> statement-breakpoint
ALTER TABLE `run` ADD `tty` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `run` ADD `actor` text;--> statement-breakpoint
ALTER TABLE `station` ADD `revoked_at` integer;--> statement-breakpoint
ALTER TABLE `station_generation` ADD `failure` text;--> statement-breakpoint
CREATE INDEX `event_created_at` ON `event` (`created_at`);--> statement-breakpoint
ALTER TABLE `blob` DROP COLUMN `grant`;