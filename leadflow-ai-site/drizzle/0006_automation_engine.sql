CREATE TABLE `events` (
        `id` text PRIMARY KEY NOT NULL,
        `business_id` text NOT NULL,
        `type` text NOT NULL,
        `lead_id` text,
        `conversation_id` text,
        `payload_json` text DEFAULT '{}',
        `created_at` integer NOT NULL,
        FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade,
        FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE set null,
        FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE set null
);--> statement-breakpoint
CREATE INDEX `events_business_type_idx` ON `events` (`business_id`,`type`,`created_at`);--> statement-breakpoint
CREATE TABLE `automation_rules` (
        `id` text PRIMARY KEY NOT NULL,
        `business_id` text NOT NULL,
        `name` text NOT NULL,
        `trigger_event` text DEFAULT '' NOT NULL,
        `delay_ms` integer DEFAULT 0 NOT NULL,
        `condition_json` text DEFAULT '{}' NOT NULL,
        `action` text NOT NULL,
        `action_config_json` text DEFAULT '{}' NOT NULL,
        `enabled` integer DEFAULT 1 NOT NULL,
        `created_at` integer NOT NULL,
        `updated_at` integer NOT NULL,
        FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_rules_business_name_idx` ON `automation_rules` (`business_id`,`name`);--> statement-breakpoint
CREATE INDEX `automation_rules_trigger_idx` ON `automation_rules` (`business_id`,`trigger_event`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
        `id` text PRIMARY KEY NOT NULL,
        `business_id` text NOT NULL,
        `lead_id` text,
        `rule_id` text,
        `rule_kind` text NOT NULL,
        `run_at` integer NOT NULL,
        `status` text DEFAULT 'pending' NOT NULL,
        `payload_json` text DEFAULT '{}' NOT NULL,
        `attempts` integer DEFAULT 0 NOT NULL,
        `last_error` text DEFAULT '' NOT NULL,
        `created_at` integer NOT NULL,
        `updated_at` integer NOT NULL,
        FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE cascade,
        FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE set null,
        FOREIGN KEY (`rule_id`) REFERENCES `automation_rules`(`id`) ON DELETE set null
);--> statement-breakpoint
CREATE INDEX `automation_runs_business_status_idx` ON `automation_runs` (`business_id`,`status`,`run_at`);
