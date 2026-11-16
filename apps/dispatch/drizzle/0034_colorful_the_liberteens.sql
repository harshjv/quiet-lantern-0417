CREATE TABLE `ship_request` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`run_id` text NOT NULL,
	`reason` text,
	`decided_by` text,
	`decided_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ship_request_task` ON `ship_request` (`task_id`);--> statement-breakpoint
CREATE INDEX `ship_request_status` ON `ship_request` (`status`);--> statement-breakpoint
ALTER TABLE `task` ADD `pull_request` text;