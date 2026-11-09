PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_secret_value` (
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
	FOREIGN KEY (`variable_id`) REFERENCES `variable`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`data_key_id`) REFERENCES `data_key`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_secret_value`("id", "created_at", "updated_at", "variable_id", "environment_id", "version", "ciphertext", "data_key_id", "created_by", "revoked_at", "needs_reentry") SELECT "id", "created_at", "updated_at", "variable_id", "environment_id", "version", "ciphertext", "data_key_id", "created_by", "revoked_at", "needs_reentry" FROM `secret_value`;--> statement-breakpoint
DROP TABLE `secret_value`;--> statement-breakpoint
ALTER TABLE `__new_secret_value` RENAME TO `secret_value`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `secret_value_default_version_unique` ON `secret_value` (`variable_id`,`version`) WHERE environment_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX `secret_value_environment_version_unique` ON `secret_value` (`variable_id`,`environment_id`,`version`) WHERE environment_id is not null;