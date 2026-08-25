CREATE TABLE `social_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`provider` text DEFAULT 'mock' NOT NULL,
	`platform` text NOT NULL,
	`message` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`posted_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `social_posts_business_due_idx` ON `social_posts` (`business_id`,`scheduled_for`);
