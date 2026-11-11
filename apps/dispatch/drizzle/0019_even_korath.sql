ALTER TABLE `sandbox` ADD `runtime` text DEFAULT 'gvisor' NOT NULL;--> statement-breakpoint
ALTER TABLE `sandbox_snapshot` ADD `runtime` text DEFAULT 'gvisor' NOT NULL;