CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`adapter` text NOT NULL,
	`model` text,
	`origin` text NOT NULL,
	`started_by` text,
	`created_at` integer NOT NULL,
	`runner_wanted` integer DEFAULT false NOT NULL,
	`runner_run_id` text,
	`runner_seen_at` integer,
	`resume` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_task_session_unique` ON `conversation` (`task_id`,`agent_session_id`);--> statement-breakpoint
CREATE TABLE `conversation_event` (
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`prompt_id` text,
	`turn_id` text,
	`agent_id` text,
	`type` text NOT NULL,
	`at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`data` text NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`task_id`, `seq`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_event_task_event_unique` ON `conversation_event` (`task_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `conversation_event_conversation` ON `conversation_event` (`task_id`,`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `conversation_event_received_at` ON `conversation_event` (`received_at`);--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`owner` text NOT NULL,
	`title` text NOT NULL,
	`repository` text NOT NULL,
	`base_branch` text,
	`branch` text NOT NULL,
	`agent` text NOT NULL,
	`model` text,
	`sandbox_id` text NOT NULL,
	`status` text DEFAULT 'setting_up' NOT NULL,
	`attention` text,
	`activity` text,
	`event_seq` integer DEFAULT 0 NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_sandbox_unique` ON `task` (`sandbox_id`);--> statement-breakpoint
CREATE INDEX `task_project` ON `task` (`project_id`);--> statement-breakpoint
CREATE TABLE `task_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`event_seq` integer,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_inbox_task_seq_unique` ON `task_inbox` (`task_id`,`seq`);--> statement-breakpoint
CREATE INDEX `task_inbox_conversation` ON `task_inbox` (`task_id`,`conversation_id`,`seq`);--> statement-breakpoint
DROP TABLE `agent_event`;--> statement-breakpoint
DROP TABLE `agent_input`;--> statement-breakpoint
DROP TABLE `agent_session`;--> statement-breakpoint
ALTER TABLE `sandbox` DROP COLUMN `agent_status`;--> statement-breakpoint
ALTER TABLE `sandbox` DROP COLUMN `agent_seq`;