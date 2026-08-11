CREATE TABLE `usage_events` (
        `id` text PRIMARY KEY NOT NULL,
        `business_id` text NOT NULL,
        `kind` text NOT NULL,
        `direction` text NOT NULL,
        `input_tokens` integer DEFAULT 0 NOT NULL,
        `output_tokens` integer DEFAULT 0 NOT NULL,
        `estimated_cost_cents` integer DEFAULT 0 NOT NULL,
        `meta_json` text DEFAULT '{}' NOT NULL,
        `created_at` integer NOT NULL,
        FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `usage_events_business_created_idx` ON `usage_events` (`business_id`,`created_at`);
