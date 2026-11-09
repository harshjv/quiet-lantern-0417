CREATE TABLE `platform_upgrade` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`staged_change_id` text,
	`station_id` text,
	`release_from` text NOT NULL,
	`release_to` text NOT NULL,
	`lockfile_before` text NOT NULL,
	`lockfile_after` text NOT NULL,
	`steps` text NOT NULL,
	`status` text NOT NULL,
	`failure` text,
	`actor` text NOT NULL,
	`backup` text,
	`finished_at` integer,
	FOREIGN KEY (`station_id`) REFERENCES `station`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `platform_upgrade_status` ON `platform_upgrade` (`status`);