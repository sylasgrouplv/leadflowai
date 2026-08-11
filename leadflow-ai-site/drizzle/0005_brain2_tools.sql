ALTER TABLE `leads` ADD `score_value` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `classification` text DEFAULT 'COLD' NOT NULL;--> statement-breakpoint
CREATE TABLE `human_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`lead_id` text,
	`priority` text DEFAULT 'medium' NOT NULL,
	`reason` text NOT NULL,
	`conversation_summary` text DEFAULT '',
	`recommended_action` text DEFAULT '',
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE set null
);--> statement-breakpoint
CREATE INDEX `human_tasks_business_idx` ON `human_tasks` (`business_id`,`status`);
