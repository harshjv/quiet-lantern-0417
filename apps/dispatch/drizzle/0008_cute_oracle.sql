CREATE TABLE `platform_release` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`release` text NOT NULL,
	`channel` text NOT NULL,
	`manifest` text NOT NULL,
	`manifest_raw` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`bundle` text NOT NULL,
	`source` text NOT NULL,
	`verified_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_release_digest_unique` ON `platform_release` (`manifest_digest`);--> statement-breakpoint
ALTER TABLE `component` ADD `signature` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `component` ADD `failure` text;