CREATE TABLE `agent_event` (
	`sandbox_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event_id` text NOT NULL,
	`session_id` text NOT NULL,
	`prompt_id` text,
	`turn_id` text,
	`agent_id` text,
	`type` text NOT NULL,
	`at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`data` text NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`sandbox_id`, `seq`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_event_sandbox_event_unique` ON `agent_event` (`sandbox_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `agent_event_session` ON `agent_event` (`sandbox_id`,`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `agent_event_received_at` ON `agent_event` (`received_at`);--> statement-breakpoint
ALTER TABLE `sandbox` ADD `agent_status` text;