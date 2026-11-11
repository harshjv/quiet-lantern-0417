PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sandbox` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`environment_id` text NOT NULL,
	`project_id` text NOT NULL,
	`station_id` text NOT NULL,
	`name` text NOT NULL,
	`image` text NOT NULL,
	`command` text,
	`size` text NOT NULL,
	`runtime` text DEFAULT 'gvisor' NOT NULL,
	`network` text DEFAULT 'isolated' NOT NULL,
	`docker` integer DEFAULT false NOT NULL,
	`egress` text NOT NULL,
	`ttl_s` integer,
	`desired_state` text NOT NULL,
	`stop_at` integer,
	`status` text NOT NULL,
	`status_reason` text,
	`exit_code` integer,
	`failure` text,
	`forked_from` text,
	`disk_from` text,
	`address` text,
	`disk_used_bytes` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`stopped_at` integer,
	`expiring_notified_at` integer,
	`deletion` text,
	`created_by` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `station`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_sandbox`("id", "created_at", "updated_at", "environment_id", "project_id", "station_id", "name", "image", "command", "size", "runtime", "network", "docker", "egress", "ttl_s", "desired_state", "stop_at", "status", "status_reason", "exit_code", "failure", "forked_from", "disk_from", "address", "disk_used_bytes", "started_at", "stopped_at", "expiring_notified_at", "deletion", "created_by") SELECT "id", "created_at", "updated_at", "environment_id", "project_id", "station_id", "name", "image", "command", "size", "runtime", "network", "docker", "egress", "ttl_s", "desired_state", "stop_at", "status", "status_reason", "exit_code", "failure", "forked_from", "disk_from", "address", "disk_used_bytes", "started_at", "stopped_at", "expiring_notified_at", "deletion", "created_by" FROM `sandbox`;--> statement-breakpoint
DROP TABLE `sandbox`;--> statement-breakpoint
ALTER TABLE `__new_sandbox` RENAME TO `sandbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_environment_name_unique` ON `sandbox` (`environment_id`,`name`);--> statement-breakpoint
CREATE INDEX `sandbox_station` ON `sandbox` (`station_id`);