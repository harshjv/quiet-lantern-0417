DROP INDEX `task_sandbox_unique`;--> statement-breakpoint
ALTER TABLE `task` ADD `machine` text DEFAULT 'own' NOT NULL;--> statement-breakpoint
ALTER TABLE `task` ADD `worktree` text;--> statement-breakpoint
ALTER TABLE `task` ADD `port` integer;--> statement-breakpoint
ALTER TABLE `task` ADD `setup_run_id` text;--> statement-breakpoint
ALTER TABLE `task` ADD `queued_at` integer;--> statement-breakpoint
CREATE INDEX `task_sandbox` ON `task` (`sandbox_id`);--> statement-breakpoint
ALTER TABLE `project` ADD `machine` text;