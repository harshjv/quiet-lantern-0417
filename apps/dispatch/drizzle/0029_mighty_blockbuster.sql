CREATE TABLE `tool_approval` (
	`task_id` text NOT NULL,
	`id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`agent_id` text,
	`tool_name` text NOT NULL,
	`tool_input` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision` text,
	`decided_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`closed_at` integer,
	PRIMARY KEY(`task_id`, `id`),
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tool_approval_status` ON `tool_approval` (`status`,`expires_at`);