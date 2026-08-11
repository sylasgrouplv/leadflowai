CREATE TABLE `follow_up_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`steps_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `followup_configs_business_idx` ON `follow_up_configs` (`business_id`);--> statement-breakpoint
ALTER TABLE `leads` ADD `opted_out` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `opt_out_channel` text DEFAULT '';