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
CREATE UNIQUE INDEX `master_key_wrap_user_unique` ON `master_key_wrap` (`user_id`);