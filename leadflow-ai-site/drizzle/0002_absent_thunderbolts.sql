CREATE TABLE `widget_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`primary_color` text DEFAULT '#4f46e5' NOT NULL,
	`position` text DEFAULT 'bottom-right' NOT NULL,
	`welcome_message` text DEFAULT '',
	`logo_url` text DEFAULT '',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `widget_settings_business_idx` ON `widget_settings` (`business_id`);