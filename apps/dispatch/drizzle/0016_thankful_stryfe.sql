CREATE TABLE `sandbox` (
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
	`network` text DEFAULT 'isolated' NOT NULL,
	`docker` integer DEFAULT false NOT NULL,
	`egress` text NOT NULL,
	`ttl_s` integer NOT NULL,
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
CREATE UNIQUE INDEX `sandbox_environment_name_unique` ON `sandbox` (`environment_id`,`name`);--> statement-breakpoint
CREATE INDEX `sandbox_station` ON `sandbox` (`station_id`);--> statement-breakpoint
CREATE TABLE `sandbox_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sandbox_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`project_id` text NOT NULL,
	`station_id` text NOT NULL,
	`name` text,
	`image` text NOT NULL,
	`size` text NOT NULL,
	`source_state` text NOT NULL,
	`status` text NOT NULL,
	`taken_at` integer,
	`exclusive_bytes` integer DEFAULT 0 NOT NULL,
	`referenced_bytes` integer DEFAULT 0 NOT NULL,
	`failure` text,
	`created_by` text NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `station`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_snapshot_environment_name_unique` ON `sandbox_snapshot` (`environment_id`,`name`) WHERE name is not null;--> statement-breakpoint
ALTER TABLE `run` ADD `sandbox_id` text;--> statement-breakpoint
ALTER TABLE `run` ADD `exec` text;--> statement-breakpoint
ALTER TABLE `station` ADD `sandbox_subnet` text;--> statement-breakpoint
ALTER TABLE `station` ADD `sandbox_limits` text DEFAULT '{"max_sandboxes":100,"max_running":20,"memory_bytes":null,"min_free_bytes":null}' NOT NULL;--> statement-breakpoint
ALTER TABLE `variable` ADD `sandbox_id` text REFERENCES sandbox(id);--> statement-breakpoint
CREATE UNIQUE INDEX `variable_sandbox_key_unique` ON `variable` (`sandbox_id`,`key`) WHERE scope = 'sandbox';