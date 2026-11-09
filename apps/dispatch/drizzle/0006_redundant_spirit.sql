CREATE TABLE `github_connect_state` (
	`state_sha256` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org` text,
	`webhooks` integer NOT NULL,
	`dashboard_origin` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE TABLE `github_delivery` (
	`guid` text PRIMARY KEY NOT NULL,
	`github_app_id` text NOT NULL,
	`event` text NOT NULL,
	`action` text,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`redelivery` integer DEFAULT false NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`github_app_id`) REFERENCES `github_app`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `github_delivery_status` ON `github_delivery` (`status`);--> statement-breakpoint
CREATE TABLE `github_status` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`sha` text NOT NULL,
	`context` text NOT NULL,
	`state` text NOT NULL,
	`description` text NOT NULL,
	`target_url` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`posted_at` integer
);
--> statement-breakpoint
CREATE INDEX `github_status_posted_at` ON `github_status` (`posted_at`);--> statement-breakpoint
CREATE TABLE `source_poll` (
	`repo` text NOT NULL,
	`branch` text NOT NULL,
	`auth` text NOT NULL,
	`sha` text,
	`etag` text,
	`interval_s` integer,
	`checked_at` integer,
	`changed_at` integer,
	`last_error` text,
	PRIMARY KEY(`repo`, `branch`)
);
--> statement-breakpoint
ALTER TABLE `github_app` ADD `data_key_id` text REFERENCES data_key(id);