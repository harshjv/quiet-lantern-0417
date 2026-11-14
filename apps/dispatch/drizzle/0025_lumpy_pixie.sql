CREATE TABLE `agent_input` (
	`id` text PRIMARY KEY NOT NULL,
	`sandbox_id` text NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`event_seq` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_input_sandbox_seq_unique` ON `agent_input` (`sandbox_id`,`seq`);--> statement-breakpoint
CREATE INDEX `agent_input_session` ON `agent_input` (`sandbox_id`,`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `agent_session` (
	`sandbox_id` text NOT NULL,
	`session_id` text NOT NULL,
	`adapter` text NOT NULL,
	`model` text,
	`started_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`runner_wanted` integer DEFAULT true NOT NULL,
	`runner_run_id` text,
	`runner_seen_at` integer,
	`resume` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`sandbox_id`, `session_id`)
);
