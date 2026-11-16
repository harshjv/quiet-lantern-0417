CREATE TABLE `machine_user` (
	`sandbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`uid` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`sandbox_id`, `user_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_user_uid_unique` ON `machine_user` (`sandbox_id`,`uid`);--> statement-breakpoint
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
