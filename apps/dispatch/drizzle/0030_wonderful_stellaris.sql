CREATE TABLE `invite` (
	`id` text PRIMARY KEY NOT NULL,
	`code_sha256` text NOT NULL,
	`role` text NOT NULL,
	`projects` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_by` text,
	`used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_code_unique` ON `invite` (`code_sha256`);--> statement-breakpoint
CREATE TABLE `member` (
	`user_id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`joined_by` text,
	`created_at` integer NOT NULL,
	`removed_at` integer
);
--> statement-breakpoint
CREATE TABLE `project_member` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`added_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_member_user` ON `project_member` (`user_id`);