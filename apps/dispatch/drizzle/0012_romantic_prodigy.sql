CREATE TABLE `doctor_check` (
	`name` text NOT NULL,
	`station` text NOT NULL,
	`status` text NOT NULL,
	`code` text,
	`changed_at` integer NOT NULL,
	PRIMARY KEY(`name`, `station`)
);
