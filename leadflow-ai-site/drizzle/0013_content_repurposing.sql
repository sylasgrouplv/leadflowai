CREATE TABLE `content_pieces` (
        `id` text PRIMARY KEY NOT NULL,
        `business_id` text NOT NULL,
        `source_type` text DEFAULT 'post' NOT NULL,
        `source_ref` text DEFAULT '' NOT NULL,
        `title` text NOT NULL,
        `body` text NOT NULL,
        `status` text DEFAULT 'draft' NOT NULL,
        `created_at` integer NOT NULL,
        `updated_at` integer NOT NULL,
        FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `content_pieces_business_idx` ON `content_pieces` (`business_id`,`created_at`);
