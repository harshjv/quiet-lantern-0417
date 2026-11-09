PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_run` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`service_id` text,
	`sandbox_id` text,
	`exec` text,
	`deployment_id` text,
	`kind` text NOT NULL,
	`command` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`exit_code` integer,
	`failure` text,
	`log_ref` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`tty` integer DEFAULT false NOT NULL,
	`actor` text,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_run`("id", "created_at", "updated_at", "service_id", "sandbox_id", "exec", "deployment_id", "kind", "command", "status", "exit_code", "failure", "log_ref", "started_at", "finished_at", "tty", "actor") SELECT "id", "created_at", "updated_at", "service_id", "sandbox_id", "exec", "deployment_id", "kind", "command", "status", "exit_code", "failure", "log_ref", "started_at", "finished_at", "tty", "actor" FROM `run`;--> statement-breakpoint
DROP TABLE `run`;--> statement-breakpoint
ALTER TABLE `__new_run` RENAME TO `run`;--> statement-breakpoint
PRAGMA foreign_keys=ON;