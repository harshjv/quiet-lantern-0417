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
CREATE TABLE `advisory` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`source_id` text NOT NULL,
	`aliases` text NOT NULL,
	`severity` text NOT NULL,
	`summary` text NOT NULL,
	`affected` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`first_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advisory_source_id_unique` ON `advisory` (`source_id`);--> statement-breakpoint
CREATE TABLE `agent_hook` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`runtime` text NOT NULL,
	`config` text NOT NULL,
	`filter` text NOT NULL,
	`token_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`disabled_at` integer,
	FOREIGN KEY (`token_id`) REFERENCES `token`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
CREATE TABLE `app` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`target_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`server_id` text NOT NULL,
	`source` text NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	`stale_reasons` text DEFAULT '[]' NOT NULL,
	`command` text,
	`build_args` text,
	`limits` text NOT NULL,
	`health` text,
	`strategy` text NOT NULL,
	`multi_writer_safe` integer DEFAULT false NOT NULL,
	`drain_timeout_s` integer DEFAULT 30 NOT NULL,
	`readonly_rootfs` integer DEFAULT false NOT NULL,
	`secrets_owner` text,
	`best_effort` integer DEFAULT false NOT NULL,
	`pre_deploy` text,
	`schedule` text,
	`firewall_policy_id` text,
	`firewall_mode` text DEFAULT 'learn' NOT NULL,
	`learn_until` integer,
	`gpu` text,
	`exports` text NOT NULL,
	`current_deployment_id` text,
	`status` text NOT NULL,
	`status_reason` text,
	`desired_state` text DEFAULT 'running' NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `target`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_target_name_unique` ON `app` (`target_id`,`name`);--> statement-breakpoint
CREATE TABLE `app_port` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`app_id` text NOT NULL,
	`port` integer NOT NULL,
	`protocol` text NOT NULL,
	`grpc` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_port_app_port_unique` ON `app_port` (`app_id`,`port`);--> statement-breakpoint
CREATE TABLE `approval` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text,
	`task_id` text,
	`title` text NOT NULL,
	`requested_by` text NOT NULL,
	`requester` text,
	`changes` text NOT NULL,
	`refs` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`self_approved` integer DEFAULT false NOT NULL,
	`reason` text,
	`deployments` text NOT NULL,
	`ship` text
);
--> statement-breakpoint
CREATE INDEX `approval_status` ON `approval` (`status`,`project_id`);--> statement-breakpoint
CREATE INDEX `approval_task` ON `approval` (`task_id`);--> statement-breakpoint
CREATE TABLE `approval_value` (
	`id` text PRIMARY KEY NOT NULL,
	`approval_id` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`data_key_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`approval_id`) REFERENCES `approval`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`data_key_id`) REFERENCES `data_key`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`target_id` text NOT NULL,
	`shared_app_id` text NOT NULL,
	`alias` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`exports` text NOT NULL,
	`hook_run_id` text,
	`error` text,
	FOREIGN KEY (`target_id`) REFERENCES `target`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shared_app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hook_run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_target_alias_unique` ON `attachment` (`target_id`,`alias`);--> statement-breakpoint
CREATE TABLE `attestation` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`build_id` text,
	`component_id` text,
	`kind` text NOT NULL,
	`generator_version` text,
	`platform` text NOT NULL,
	`digest` text,
	`predicate_ref` text NOT NULL,
	`base_images` text NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `build`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`component_id`) REFERENCES `component`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attestation_exactly_one_subject" CHECK((build_id is null) <> (component_id is null))
);
--> statement-breakpoint
CREATE TABLE `audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`request_id` text NOT NULL,
	`idempotency_key` text,
	`purpose` text,
	`before` text,
	`after` text
);
--> statement-breakpoint
CREATE TABLE `blob` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`kind` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`expires_at` integer NOT NULL,
	`app_id` text,
	`grant_sha256` text,
	`grant_server_id` text,
	`grant_expires_at` integer
);
--> statement-breakpoint
CREATE TABLE `build` (
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
CREATE TABLE `component` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`server_id` text,
	`name` text NOT NULL,
	`container_id` text,
	`version` text NOT NULL,
	`digest` text,
	`since` integer NOT NULL,
	`lockfile_version` text NOT NULL,
	`lockfile_digest` text,
	`status` text DEFAULT 'ok' NOT NULL,
	`signature` text DEFAULT 'pending' NOT NULL,
	`failure` text,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `component_instance_name_unique` ON `component` (`name`) WHERE server_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX `component_server_name_unique` ON `component` (`server_id`,`name`) WHERE server_id is not null;--> statement-breakpoint
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
CREATE TABLE `data_key` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`wrapped` blob NOT NULL,
	`wrapped_next` blob
);
--> statement-breakpoint
CREATE TABLE `deployment` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`app_id` text NOT NULL,
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
	`base_images` text NOT NULL,
	`image_pruned_at` integer,
	`health_failed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_app_number_unique` ON `deployment` (`app_id`,`number`);--> statement-breakpoint
CREATE TABLE `deployment_step` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deployment_id` text NOT NULL,
	`step` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer NOT NULL,
	`detail` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_step_deployment_step_attempt_unique` ON `deployment_step` (`deployment_id`,`step`,`attempt`);--> statement-breakpoint
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
CREATE TABLE `doctor_check` (
	`name` text NOT NULL,
	`server` text NOT NULL,
	`status` text NOT NULL,
	`code` text,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`name`, `server`)
);
--> statement-breakpoint
CREATE TABLE `domain` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`app_port_id` text NOT NULL,
	`hostname` text NOT NULL,
	`kind` text NOT NULL,
	`ingress` text NOT NULL,
	`cloudflare` text,
	`certificate` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_checked_at` integer,
	`error` text,
	FOREIGN KEY (`app_port_id`) REFERENCES `app_port`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_hostname_unique` ON `domain` (`hostname`);--> statement-breakpoint
CREATE TABLE `drift` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`server_id` text NOT NULL,
	`object` text NOT NULL,
	`observed` text,
	`desired` text,
	`status` text DEFAULT 'open' NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `event` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`type` text NOT NULL,
	`subject` text NOT NULL,
	`payload` text NOT NULL,
	`delivered` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_created_at` ON `event` (`created_at`);--> statement-breakpoint
CREATE TABLE `firewall_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`editable` integer DEFAULT true NOT NULL,
	`includes` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`acknowledged_generation` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `firewall_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`policy_id` text NOT NULL,
	`match` text NOT NULL,
	`ports` text NOT NULL,
	`source` text NOT NULL,
	`derived_from` text,
	FOREIGN KEY (`policy_id`) REFERENCES `firewall_policy`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `flow_rollup` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`app_id` text NOT NULL,
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
CREATE TABLE `github_app` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`app_id` integer NOT NULL,
	`slug` text NOT NULL,
	`client_id` text NOT NULL,
	`owner` text NOT NULL,
	`webhooks` integer NOT NULL,
	`private_key` blob NOT NULL,
	`client_secret` blob NOT NULL,
	`webhook_secret` blob,
	`data_key_id` text,
	FOREIGN KEY (`data_key_id`) REFERENCES `data_key`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_app_owner_unique` ON `github_app` (`owner`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_app_app_id_unique` ON `github_app` (`app_id`);--> statement-breakpoint
CREATE TABLE `github_connect_state` (
	`state_sha256` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org` text,
	`webhooks` integer NOT NULL,
	`dashboard_origin` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE TABLE `github_delivery` (
	`guid` text PRIMARY KEY NOT NULL,
	`github_app_id` text NOT NULL,
	`event` text NOT NULL,
	`action` text,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`redelivery` integer DEFAULT false NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`github_app_id`) REFERENCES `github_app`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `github_delivery_status` ON `github_delivery` (`status`);--> statement-breakpoint
CREATE TABLE `github_installation` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`github_app_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`account` text NOT NULL,
	`repository_selection` text NOT NULL,
	`suspended_at` integer,
	FOREIGN KEY (`github_app_id`) REFERENCES `github_app`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installation_installation_id_unique` ON `github_installation` (`installation_id`);--> statement-breakpoint
CREATE TABLE `github_status` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`sha` text NOT NULL,
	`context` text NOT NULL,
	`state` text NOT NULL,
	`description` text NOT NULL,
	`target_url` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`posted_at` integer
);
--> statement-breakpoint
CREATE INDEX `github_status_posted_at` ON `github_status` (`posted_at`);--> statement-breakpoint
CREATE TABLE `grant` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`key_id` text NOT NULL,
	`project_id` text NOT NULL,
	`alias` text,
	`source` text NOT NULL,
	`attachment_id` text,
	FOREIGN KEY (`key_id`) REFERENCES `key`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
CREATE TABLE `invite` (
	`id` text PRIMARY KEY NOT NULL,
	`code_sha256` text NOT NULL,
	`role` text NOT NULL,
	`projects` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_by` text,
	`used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_code_unique` ON `invite` (`code_sha256`);--> statement-breakpoint
CREATE TABLE `ipam_allocation` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`target_id` text NOT NULL,
	`server_id` text NOT NULL,
	`subnet` text NOT NULL,
	`gateway` text NOT NULL,
	`docker_network_id` text,
	FOREIGN KEY (`target_id`) REFERENCES `target`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ipam_allocation_target_server_unique` ON `ipam_allocation` (`target_id`,`server_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ipam_allocation_server_subnet_unique` ON `ipam_allocation` (`server_id`,`subnet`);--> statement-breakpoint
CREATE TABLE `jwks` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`alg` text,
	`crv` text
);
--> statement-breakpoint
CREATE TABLE `key` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`app_id` text,
	`machine_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`reference` text,
	`injection` text DEFAULT 'env' NOT NULL,
	`build` integer DEFAULT false NOT NULL,
	`current_value_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machine`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `key_global_name_unique` ON `key` (`name`) WHERE scope = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX `key_project_name_unique` ON `key` (`project_id`,`name`) WHERE scope = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX `key_app_name_unique` ON `key` (`app_id`,`name`) WHERE scope = 'app';--> statement-breakpoint
CREATE UNIQUE INDEX `key_machine_name_unique` ON `key` (`machine_id`,`name`) WHERE scope = 'machine';--> statement-breakpoint
CREATE TABLE `machine` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`target_id` text NOT NULL,
	`project_id` text NOT NULL,
	`server_id` text NOT NULL,
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
	`workspace` text,
	`created_by` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_target_name_unique` ON `machine` (`target_id`,`name`);--> statement-breakpoint
CREATE INDEX `machine_server` ON `machine` (`server_id`);--> statement-breakpoint
CREATE TABLE `machine_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`machine_id` text NOT NULL,
	`target_id` text NOT NULL,
	`project_id` text NOT NULL,
	`server_id` text NOT NULL,
	`name` text,
	`image` text NOT NULL,
	`size` text NOT NULL,
	`runtime` text DEFAULT 'gvisor' NOT NULL,
	`settings` text DEFAULT '{"network":"isolated","docker":false,"egress":{"mode":"open","domains":[]},"command":null,"ttl_s":3600}' NOT NULL,
	`source_state` text NOT NULL,
	`status` text NOT NULL,
	`taken_at` integer,
	`exclusive_bytes` integer DEFAULT 0 NOT NULL,
	`referenced_bytes` integer DEFAULT 0 NOT NULL,
	`failure` text,
	`created_by` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_snapshot_target_name_unique` ON `machine_snapshot` (`target_id`,`name`) WHERE name is not null;--> statement-breakpoint
CREATE TABLE `machine_user` (
	`machine_id` text NOT NULL,
	`user_id` text NOT NULL,
	`uid` integer NOT NULL,
	`name` text NOT NULL,
	`token_id` text,
	`token_key` blob,
	`token_placeholder` text,
	`key_placeholders` text,
	`data_key_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`machine_id`, `user_id`),
	FOREIGN KEY (`data_key_id`) REFERENCES `data_key`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_user_uid_unique` ON `machine_user` (`machine_id`,`uid`);--> statement-breakpoint
CREATE TABLE `master_key_wrap` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`kdf` text NOT NULL,
	`wrapped` blob NOT NULL,
	`wrapped_next` blob
);
--> statement-breakpoint
CREATE UNIQUE INDEX `master_key_wrap_user_unique` ON `master_key_wrap` (`user_id`);--> statement-breakpoint
CREATE TABLE `member` (
	`user_id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`joined_by` text,
	`created_at` integer NOT NULL,
	`removed_at` integer
);
--> statement-breakpoint
CREATE TABLE `member_key` (
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`data_key_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer,
	PRIMARY KEY(`user_id`, `name`),
	FOREIGN KEY (`data_key_id`) REFERENCES `data_key`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notification_channel` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`filter` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`failing_since` integer
);
--> statement-breakpoint
CREATE TABLE `oauth_access_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text,
	`reference_id` text,
	`authorization_code_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`refresh_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked` integer,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refresh_id`) REFERENCES `oauth_refresh_token`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_token_token_unique` ON `oauth_access_token` (`token`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_clientId_idx` ON `oauth_access_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_sessionId_idx` ON `oauth_access_token` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_userId_idx` ON `oauth_access_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_authorizationCodeId_idx` ON `oauth_access_token` (`authorization_code_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_refreshId_idx` ON `oauth_access_token` (`refresh_id`);--> statement-breakpoint
CREATE TABLE `oauth_client` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`client_discovery_id` text,
	`disabled` integer DEFAULT false,
	`skip_consent` integer,
	`enable_end_session` integer,
	`subject_type` text,
	`scopes` text,
	`client_credentials_scopes` text DEFAULT '[]',
	`user_id` text,
	`created_at` integer,
	`updated_at` integer,
	`name` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`software_id` text,
	`software_version` text,
	`software_statement` text,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`backchannel_logout_uri` text,
	`backchannel_logout_session_required` integer,
	`token_endpoint_auth_method` text,
	`application_type` text,
	`jwks` text,
	`jwks_uri` text,
	`grant_types` text,
	`response_types` text,
	`require_pkce` integer,
	`dpop_bound_access_tokens` integer DEFAULT false,
	`reference_id` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_client_client_id_unique` ON `oauth_client` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthClient_userId_idx` ON `oauth_client` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_client_assertion` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_client_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`metadata` text,
	`created_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `oauth_resource`(`identifier`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthClientResource_clientId_resourceId_uidx` ON `oauth_client_resource` (`client_id`,`resource_id`);--> statement-breakpoint
CREATE INDEX `oauthClientResource_clientId_idx` ON `oauth_client_resource` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthClientResource_resourceId_idx` ON `oauth_client_resource` (`resource_id`);--> statement-breakpoint
CREATE TABLE `oauth_consent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`reference_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauthConsent_clientId_idx` ON `oauth_consent` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthConsent_userId_idx` ON `oauth_consent` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text NOT NULL,
	`reference_id` text,
	`authorization_code_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked` integer,
	`rotated_at` integer,
	`rotation_replay_response` text,
	`rotation_replay_expires_at` integer,
	`auth_time` integer,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_token_token_unique` ON `oauth_refresh_token` (`token`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_clientId_idx` ON `oauth_refresh_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_sessionId_idx` ON `oauth_refresh_token` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_userId_idx` ON `oauth_refresh_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_authorizationCodeId_idx` ON `oauth_refresh_token` (`authorization_code_id`);--> statement-breakpoint
CREATE TABLE `oauth_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`name` text NOT NULL,
	`access_token_ttl` integer,
	`refresh_token_ttl` integer,
	`signing_algorithm` text,
	`signing_key_id` text,
	`allowed_scopes` text,
	`custom_claims` text,
	`dpop_bound_access_tokens_required` integer DEFAULT false,
	`disabled` integer DEFAULT false,
	`created_at` integer,
	`updated_at` integer,
	`policy_version` integer DEFAULT 1,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_resource_identifier_unique` ON `oauth_resource` (`identifier`);--> statement-breakpoint
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
CREATE TABLE `platform_release` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`release` text NOT NULL,
	`channel` text NOT NULL,
	`manifest` text NOT NULL,
	`manifest_raw` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`bundle` text NOT NULL,
	`source` text NOT NULL,
	`verified_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_release_digest_unique` ON `platform_release` (`manifest_digest`);--> statement-breakpoint
CREATE TABLE `platform_upgrade` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`approval_id` text,
	`server_id` text,
	`release_from` text NOT NULL,
	`release_to` text NOT NULL,
	`lockfile_before` text NOT NULL,
	`lockfile_after` text NOT NULL,
	`steps` text NOT NULL,
	`status` text NOT NULL,
	`failure` text,
	`actor` text NOT NULL,
	`backup` text,
	`finished_at` integer,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `platform_upgrade_status` ON `platform_upgrade` (`status`);--> statement-breakpoint
CREATE TABLE `port_allocation` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`app_port_id` text NOT NULL,
	`server_id` text NOT NULL,
	`host_port` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`app_port_id`) REFERENCES `app_port`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `port_allocation_server_host_port_active_unique` ON `port_allocation` (`server_id`,`host_port`) WHERE status = 'active';--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`name` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`manifest_path` text,
	`build_policy_id` text,
	`build_cache_bytes` integer DEFAULT 10737418240 NOT NULL,
	`workshop_uid_base` integer NOT NULL,
	`image_retention_count` integer DEFAULT 5 NOT NULL,
	`base_image_auto_rebuild` integer DEFAULT false NOT NULL,
	`pull_request_previews` integer DEFAULT true NOT NULL,
	`machine` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_name_unique` ON `project` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_workshop_uid_base_unique` ON `project` (`workshop_uid_base`);--> statement-breakpoint
CREATE TABLE `project_member` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`added_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_member_user` ON `project_member` (`user_id`);--> statement-breakpoint
CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`app_id` text,
	`machine_id` text,
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
CREATE TABLE `secret_value` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`key_id` text NOT NULL,
	`target` text DEFAULT 'production' NOT NULL,
	`version` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`data_key_id` text NOT NULL,
	`created_by` text NOT NULL,
	`revoked_at` integer,
	`needs_reentry` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`key_id`) REFERENCES `key`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`data_key_id`) REFERENCES `data_key`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_value_target_version_unique` ON `secret_value` (`key_id`,`target`,`version`);--> statement-breakpoint
CREATE TABLE `server` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`name` text NOT NULL,
	`public_key` text,
	`endpoint` text,
	`relay` integer DEFAULT false NOT NULL,
	`os` text,
	`arch` text,
	`capabilities` text,
	`intermittent` integer DEFAULT false NOT NULL,
	`routes` text,
	`resources` text,
	`status` text DEFAULT 'enrolling' NOT NULL,
	`draining` integer DEFAULT false NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer,
	`version_skew` text DEFAULT 'ok' NOT NULL,
	`concurrency_cap` integer DEFAULT 2 NOT NULL,
	`tracks_address` text,
	`registry_subnet` text,
	`registry_address` text,
	`hosts_dispatch` integer DEFAULT false NOT NULL,
	`generation_hash` text,
	`machine_subnet` text,
	`machine_limits` text DEFAULT '{"max_machines":100,"max_running":20,"memory_bytes":null,"min_free_bytes":null}' NOT NULL,
	`default_machine_runtime` text,
	`cloudflare_tunnel_id` text,
	`public_address` text,
	`identity_key` text,
	`sleep_schedule` text,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_name_unique` ON `server` (`name`);--> statement-breakpoint
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
	`pop_jkt` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `setting` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setting_key_unique` ON `setting` (`key`);--> statement-breakpoint
CREATE TABLE `source_poll` (
	`repo` text NOT NULL,
	`branch` text NOT NULL,
	`auth` text NOT NULL,
	`sha` text,
	`etag` text,
	`interval_s` integer,
	`checked_at` integer,
	`changed_at` integer,
	`last_error` text,
	PRIMARY KEY(`repo`, `branch`)
);
--> statement-breakpoint
CREATE TABLE `station_generation` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`server_id` text NOT NULL,
	`generation` integer NOT NULL,
	`document` text NOT NULL,
	`hash` text NOT NULL,
	`ack` text,
	`failure` text,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_generation_server_generation_unique` ON `station_generation` (`server_id`,`generation`);--> statement-breakpoint
CREATE TABLE `station_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`server_id` text NOT NULL,
	`epoch` text NOT NULL,
	`committed_seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_outbox_server_epoch_unique` ON `station_outbox` (`server_id`,`epoch`);--> statement-breakpoint
CREATE TABLE `target` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`origin` text,
	`expires_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `target_project_name_unique` ON `target` (`project_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `target_production_unique` ON `target` (`project_id`) WHERE kind = 'production';--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`target_id` text NOT NULL,
	`owner` text NOT NULL,
	`title` text NOT NULL,
	`repository` text NOT NULL,
	`base_branch` text,
	`branch` text NOT NULL,
	`agent` text NOT NULL,
	`model` text,
	`machine_id` text NOT NULL,
	`machine` text DEFAULT 'own' NOT NULL,
	`worktree` text,
	`port` integer,
	`setup_run_id` text,
	`queued_at` integer,
	`preview_id` text,
	`pull_request` text,
	`status` text DEFAULT 'setting_up' NOT NULL,
	`attention` text,
	`activity` text,
	`event_seq` integer DEFAULT 0 NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `task_machine` ON `task` (`machine_id`);--> statement-breakpoint
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
CREATE TABLE `template` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `template_name_unique` ON `template` (`name`);--> statement-breakpoint
CREATE TABLE `template_version` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`template_id` text NOT NULL,
	`version` text NOT NULL,
	`spec` text NOT NULL,
	`hooks_image` text,
	FOREIGN KEY (`template_id`) REFERENCES `template`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `template_version_template_version_unique` ON `template_version` (`template_id`,`version`);--> statement-breakpoint
CREATE TABLE `token` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`client_id` text,
	`api_key_id` text,
	`secret_sha256` text,
	`server_id` text,
	`used_at` integer,
	`machine_held` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `token_api_key_unique` ON `token` (`api_key_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `token_secret_sha256_unique` ON `token` (`secret_sha256`);--> statement-breakpoint
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
CREATE INDEX `tool_approval_status` ON `tool_approval` (`status`,`expires_at`);--> statement-breakpoint
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
CREATE TABLE `vex_statement` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text,
	`advisory_id` text NOT NULL,
	`product` text NOT NULL,
	`subcomponent` text NOT NULL,
	`status` text NOT NULL,
	`justification` text,
	`actor` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`advisory_id`) REFERENCES `advisory`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `virtual_ip` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`app_id` text,
	`component` text,
	`target_id` text NOT NULL,
	`address` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `target`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `virtual_ip_address_unique` ON `virtual_ip` (`address`);--> statement-breakpoint
CREATE TABLE `volume` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`owner` text NOT NULL,
	`app_id` text,
	`project_id` text,
	`mount_path` text NOT NULL,
	`server_id` text NOT NULL,
	`docker_name` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`retain_until` integer,
	FOREIGN KEY (`app_id`) REFERENCES `app`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `volume_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`volume_id` text NOT NULL,
	`taken_at` integer NOT NULL,
	`location` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`server_id` text,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`target` text,
	`objects` text,
	`sha256` text,
	`archive_bytes` integer,
	`consistent` integer,
	`finished_at` integer,
	`failure` text,
	FOREIGN KEY (`volume_id`) REFERENCES `volume`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`server_id`) REFERENCES `server`(`id`) ON UPDATE no action ON DELETE no action
);
