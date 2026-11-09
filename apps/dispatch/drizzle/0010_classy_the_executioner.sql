ALTER TABLE `volume_snapshot` ADD `station_id` text REFERENCES station(id);--> statement-breakpoint
ALTER TABLE `volume_snapshot` ADD `trigger` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `volume_snapshot` ADD `target` text;--> statement-breakpoint
ALTER TABLE `volume_snapshot` ADD `objects` text;--> statement-breakpoint
ALTER TABLE `volume_snapshot` ADD `sha256` text;--> statement-breakpoint
ALTER TABLE `volume_snapshot` ADD `archive_bytes` integer;--> statement-breakpoint
ALTER TABLE `volume_snapshot` ADD `consistent` integer;--> statement-breakpoint
ALTER TABLE `volume_snapshot` ADD `finished_at` integer;--> statement-breakpoint
ALTER TABLE `volume_snapshot` ADD `failure` text;