ALTER TABLE `machine_user` ADD `token_id` text;--> statement-breakpoint
ALTER TABLE `machine_user` ADD `token_key` blob;--> statement-breakpoint
ALTER TABLE `machine_user` ADD `data_key_id` text REFERENCES data_key(id);