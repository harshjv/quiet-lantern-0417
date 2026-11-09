CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`reference_id` text NOT NULL,
	`prefix` text,
	`key` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true,
	`rate_limit_enabled` integer DEFAULT true,
	`rate_limit_time_window` integer DEFAULT 60000,
	`rate_limit_max` integer DEFAULT 600,
	`request_count` integer DEFAULT 0,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`permissions` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `apikey_configId_idx` ON `apikey` (`config_id`);--> statement-breakpoint
CREATE INDEX `apikey_referenceId_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE INDEX `apikey_key_idx` ON `apikey` (`key`);--> statement-breakpoint
CREATE TABLE `device_code` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_polled_at` integer,
	`polling_interval` integer,
	`client_id` text,
	`scope` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deviceCode_deviceCode_uidx` ON `device_code` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `deviceCode_userCode_uidx` ON `device_code` (`user_code`);--> statement-breakpoint
CREATE TABLE `idempotency_record` (
	`actor` text NOT NULL,
	`key` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`request_sha256` text NOT NULL,
	`status` integer,
	`response` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`actor`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_record_expires_at` ON `idempotency_record` (`expires_at`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_userId_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_credentialID_idx` ON `passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `staged_value` (
	`id` text PRIMARY KEY NOT NULL,
	`staged_change_id` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`data_key_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`staged_change_id`) REFERENCES `staged_change`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`data_key_id`) REFERENCES `data_key`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL,
	`verified` integer DEFAULT true,
	`failed_verification_count` integer DEFAULT 0,
	`locked_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `twoFactor_secret_idx` ON `two_factor` (`secret`);--> statement-breakpoint
CREATE INDEX `twoFactor_userId_idx` ON `two_factor` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`two_factor_enabled` integer DEFAULT false,
	`role` text,
	`banned` integer DEFAULT false,
	`ban_reason` text,
	`ban_expires` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_build` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deployment_id` text NOT NULL,
	`project_id` text NOT NULL,
	`source` text NOT NULL,
	`builder` text NOT NULL,
	`image_ref` text,
	`index_digest` text,
	`cache_key` text NOT NULL,
	`detail` text NOT NULL,
	`railpack_version` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`log_ref` text NOT NULL,
	`duration_s` integer,
	`failure` text,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_build`("id", "created_at", "updated_at", "deployment_id", "project_id", "source", "builder", "image_ref", "index_digest", "cache_key", "detail", "railpack_version", "status", "log_ref", "duration_s", "failure") SELECT "id", "created_at", "updated_at", "deployment_id", "project_id", "source", "builder", "image_ref", "index_digest", "cache_key", "detail", "railpack_version", "status", "log_ref", "duration_s", "failure" FROM `build`;--> statement-breakpoint
DROP TABLE `build`;--> statement-breakpoint
ALTER TABLE `__new_build` RENAME TO `build`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_deployment` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`service_id` text NOT NULL,
	`number` integer NOT NULL,
	`trigger` text NOT NULL,
	`image_ref` text,
	`build_id` text,
	`env_snapshot` text NOT NULL,
	`config_snapshot` text NOT NULL,
	`strategy` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`failure` text,
	`cancel_reason` text,
	`started_at` integer,
	`finished_at` integer,
	`base_images` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_deployment`("id", "created_at", "updated_at", "service_id", "number", "trigger", "image_ref", "build_id", "env_snapshot", "config_snapshot", "strategy", "status", "failure", "cancel_reason", "started_at", "finished_at", "base_images") SELECT "id", "created_at", "updated_at", "service_id", "number", "trigger", "image_ref", "build_id", "env_snapshot", "config_snapshot", "strategy", "status", "failure", "cancel_reason", "started_at", "finished_at", "base_images" FROM `deployment`;--> statement-breakpoint
DROP TABLE `deployment`;--> statement-breakpoint
ALTER TABLE `__new_deployment` RENAME TO `deployment`;--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_service_number_unique` ON `deployment` (`service_id`,`number`);--> statement-breakpoint
CREATE TABLE `__new_flow_rollup` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`service_id` text NOT NULL,
	`deployment_id` text NOT NULL,
	`minute` integer NOT NULL,
	`destination` text NOT NULL,
	`port` integer NOT NULL,
	`protocol` text NOT NULL,
	`verdict` text NOT NULL,
	`connections` integer NOT NULL,
	`bytes_out` integer NOT NULL,
	`bytes_in` integer NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_flow_rollup`("id", "created_at", "updated_at", "service_id", "deployment_id", "minute", "destination", "port", "protocol", "verdict", "connections", "bytes_out", "bytes_in") SELECT "id", "created_at", "updated_at", "service_id", "deployment_id", "minute", "destination", "port", "protocol", "verdict", "connections", "bytes_out", "bytes_in" FROM `flow_rollup`;--> statement-breakpoint
DROP TABLE `flow_rollup`;--> statement-breakpoint
ALTER TABLE `__new_flow_rollup` RENAME TO `flow_rollup`;--> statement-breakpoint
CREATE TABLE `__new_run` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`service_id` text NOT NULL,
	`deployment_id` text,
	`kind` text NOT NULL,
	`command` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`exit_code` integer,
	`failure` text,
	`log_ref` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_run`("id", "created_at", "updated_at", "service_id", "deployment_id", "kind", "command", "status", "exit_code", "failure", "log_ref", "started_at", "finished_at") SELECT "id", "created_at", "updated_at", "service_id", "deployment_id", "kind", "command", "status", "exit_code", "failure", "log_ref", "started_at", "finished_at" FROM `run`;--> statement-breakpoint
DROP TABLE `run`;--> statement-breakpoint
ALTER TABLE `__new_run` RENAME TO `run`;--> statement-breakpoint
CREATE TABLE `__new_staged_change` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`environment_id` text,
	`actor` text NOT NULL,
	`changes` text NOT NULL,
	`refs` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`accepted_by` text,
	`deployments` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_staged_change`("id", "created_at", "updated_at", "environment_id", "actor", "changes", "refs", "source", "status", "accepted_by", "deployments") SELECT "id", "created_at", "updated_at", "environment_id", "actor", "changes", "refs", "source", "status", "accepted_by", "deployments" FROM `staged_change`;--> statement-breakpoint
DROP TABLE `staged_change`;--> statement-breakpoint
ALTER TABLE `__new_staged_change` RENAME TO `staged_change`;--> statement-breakpoint
ALTER TABLE `token` ADD `api_key_id` text;--> statement-breakpoint
ALTER TABLE `token` ADD `secret_sha256` text;--> statement-breakpoint
ALTER TABLE `token` ADD `station_id` text REFERENCES station(id);--> statement-breakpoint
ALTER TABLE `token` ADD `used_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `token_api_key_unique` ON `token` (`api_key_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `token_secret_sha256_unique` ON `token` (`secret_sha256`);--> statement-breakpoint
ALTER TABLE `volume` ADD `project_id` text REFERENCES project(id);