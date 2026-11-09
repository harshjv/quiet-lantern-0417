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
CREATE TABLE `attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`environment_id` text NOT NULL,
	`shared_service_id` text NOT NULL,
	`alias` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`exports` text NOT NULL,
	`hook_run_id` text,
	`error` text,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shared_service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hook_run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_environment_alias_unique` ON `attachment` (`environment_id`,`alias`);--> statement-breakpoint
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
	`grant` text NOT NULL
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
	FOREIGN KEY (`deployment_id`) REFERENCES `deployment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `component` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`station_id` text,
	`name` text NOT NULL,
	`container_id` text,
	`version` text NOT NULL,
	`digest` text,
	`since` integer NOT NULL,
	`lockfile_version` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `station`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `component_instance_name_unique` ON `component` (`name`) WHERE station_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX `component_station_name_unique` ON `component` (`station_id`,`name`) WHERE station_id is not null;--> statement-breakpoint
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
	`base_images` text NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_service_number_unique` ON `deployment` (`service_id`,`number`);--> statement-breakpoint
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
CREATE TABLE `domain` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`service_port_id` text NOT NULL,
	`hostname` text NOT NULL,
	`kind` text NOT NULL,
	`ingress` text NOT NULL,
	`cloudflare` text,
	`certificate` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_checked_at` integer,
	`error` text,
	FOREIGN KEY (`service_port_id`) REFERENCES `service_port`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_hostname_unique` ON `domain` (`hostname`);--> statement-breakpoint
CREATE TABLE `drift` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`station_id` text NOT NULL,
	`object` text NOT NULL,
	`observed` text,
	`desired` text,
	`status` text DEFAULT 'open' NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `station`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `environment` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`protected` integer DEFAULT false NOT NULL,
	`ephemeral` integer DEFAULT false NOT NULL,
	`source_environment_id` text,
	`pull_request` text,
	`ttl_seconds` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_project_name_unique` ON `environment` (`project_id`,`name`);--> statement-breakpoint
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
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE no action,
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
	`webhook_secret` blob
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_app_owner_unique` ON `github_app` (`owner`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_app_app_id_unique` ON `github_app` (`app_id`);--> statement-breakpoint
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
CREATE TABLE `grant` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`variable_id` text NOT NULL,
	`project_id` text NOT NULL,
	`alias` text,
	`source` text NOT NULL,
	`attachment_id` text,
	FOREIGN KEY (`variable_id`) REFERENCES `variable`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ipam_allocation` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`environment_id` text NOT NULL,
	`station_id` text NOT NULL,
	`subnet` text NOT NULL,
	`gateway` text NOT NULL,
	`docker_network_id` text,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`station_id`) REFERENCES `station`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ipam_allocation_environment_station_unique` ON `ipam_allocation` (`environment_id`,`station_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ipam_allocation_station_subnet_unique` ON `ipam_allocation` (`station_id`,`subnet`);--> statement-breakpoint
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
CREATE TABLE `port_allocation` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`service_port_id` text NOT NULL,
	`station_id` text NOT NULL,
	`host_port` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`service_port_id`) REFERENCES `service_port`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`station_id`) REFERENCES `station`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `port_allocation_station_host_port_active_unique` ON `port_allocation` (`station_id`,`host_port`) WHERE status = 'active';--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`name` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`manifest_path` text,
	`default_environment_id` text NOT NULL,
	`build_policy_id` text,
	`build_cache_bytes` integer DEFAULT 10737418240 NOT NULL,
	`workshop_uid_base` integer NOT NULL,
	`image_retention_count` integer DEFAULT 5 NOT NULL,
	`base_image_auto_rebuild` integer DEFAULT false NOT NULL,
	`pr_environments` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_name_unique` ON `project` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_workshop_uid_base_unique` ON `project` (`workshop_uid_base`);--> statement-breakpoint
CREATE TABLE `run` (
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
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `secret_value` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`variable_id` text NOT NULL,
	`environment_id` text,
	`version` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`data_key_id` text NOT NULL,
	`created_by` text NOT NULL,
	`revoked_at` integer,
	`needs_reentry` integer DEFAULT false NOT NULL,
	`staged_change_id` text,
	FOREIGN KEY (`variable_id`) REFERENCES `variable`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`data_key_id`) REFERENCES `data_key`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`staged_change_id`) REFERENCES `staged_change`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_value_default_version_unique` ON `secret_value` (`variable_id`,`version`) WHERE environment_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX `secret_value_environment_version_unique` ON `secret_value` (`variable_id`,`environment_id`,`version`) WHERE environment_id is not null;--> statement-breakpoint
CREATE TABLE `service` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`environment_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`station_id` text NOT NULL,
	`source` text NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
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
	`status` text DEFAULT 'amber' NOT NULL,
	`status_reason` text,
	`desired_state` text DEFAULT 'running' NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`station_id`) REFERENCES `station`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_environment_name_unique` ON `service` (`environment_id`,`name`);--> statement-breakpoint
CREATE TABLE `service_port` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`service_id` text NOT NULL,
	`port` integer NOT NULL,
	`protocol` text NOT NULL,
	`grpc` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_port_service_port_unique` ON `service_port` (`service_id`,`port`);--> statement-breakpoint
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
CREATE TABLE `staged_change` (
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
	`deployments` text NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `station` (
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
	`generation` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer,
	`version_skew` text DEFAULT 'ok' NOT NULL,
	`concurrency_cap` integer DEFAULT 2 NOT NULL,
	`tracks_address` text,
	`registry_subnet` text,
	`registry_address` text,
	`hosts_dispatch` integer DEFAULT false NOT NULL,
	`generation_hash` text,
	`cloudflare_tunnel_id` text,
	`public_address` text,
	`identity_key` text,
	`sleep_schedule` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `station_name_unique` ON `station` (`name`);--> statement-breakpoint
CREATE TABLE `station_generation` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`station_id` text NOT NULL,
	`generation` integer NOT NULL,
	`document` text NOT NULL,
	`hash` text NOT NULL,
	`ack` text,
	FOREIGN KEY (`station_id`) REFERENCES `station`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `station_generation_station_generation_unique` ON `station_generation` (`station_id`,`generation`);--> statement-breakpoint
CREATE TABLE `station_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`station_id` text NOT NULL,
	`epoch` text NOT NULL,
	`committed_seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`station_id`) REFERENCES `station`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `station_outbox_station_epoch_unique` ON `station_outbox` (`station_id`,`epoch`);--> statement-breakpoint
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
	`client_id` text
);
--> statement-breakpoint
CREATE TABLE `variable` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`service_id` text,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`reference` text,
	`injection` text DEFAULT 'env' NOT NULL,
	`build` integer DEFAULT false NOT NULL,
	`current_value_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variable_global_key_unique` ON `variable` (`key`) WHERE scope = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX `variable_project_key_unique` ON `variable` (`project_id`,`key`) WHERE scope = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX `variable_service_key_unique` ON `variable` (`service_id`,`key`) WHERE scope = 'service';--> statement-breakpoint
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
	`service_id` text,
	`component` text,
	`environment_id` text NOT NULL,
	`address` text NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `virtual_ip_environment_address_unique` ON `virtual_ip` (`environment_id`,`address`);--> statement-breakpoint
CREATE TABLE `volume` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`owner` text NOT NULL,
	`service_id` text,
	`mount_path` text NOT NULL,
	`station_id` text NOT NULL,
	`docker_name` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`retain_until` integer,
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`station_id`) REFERENCES `station`(`id`) ON UPDATE no action ON DELETE no action
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
	FOREIGN KEY (`volume_id`) REFERENCES `volume`(`id`) ON UPDATE no action ON DELETE no action
);
