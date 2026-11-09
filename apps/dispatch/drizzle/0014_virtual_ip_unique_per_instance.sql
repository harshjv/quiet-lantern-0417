DROP INDEX `virtual_ip_environment_address_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `virtual_ip_address_unique` ON `virtual_ip` (`address`);