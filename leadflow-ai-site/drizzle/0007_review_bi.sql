ALTER TABLE `services` ADD `average_value_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE `review_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`delay_days` integer DEFAULT 1 NOT NULL,
	`review_url` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `review_configs_business_idx` ON `review_configs` (`business_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`appointment_id` text,
	`feedback_text` text DEFAULT '' NOT NULL,
	`sentiment` text DEFAULT 'unknown' NOT NULL,
	`review_request_sent_at` integer,
	`review_link_sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE cascade,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE set null
);--> statement-breakpoint
CREATE INDEX `reviews_business_idx` ON `reviews` (`business_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_business_sentiment_idx` ON `reviews` (`business_id`,`sentiment`);--> statement-breakpoint
CREATE TABLE `business_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`week_start` integer NOT NULL,
	`metrics_json` text DEFAULT '{}' NOT NULL,
	`narrative_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `business_reports_biz_week_idx` ON `business_reports` (`business_id`,`week_start`);
