CREATE TABLE `invoices` (
        `id` text PRIMARY KEY NOT NULL,
        `business_id` text NOT NULL,
        `customer_name` text NOT NULL,
        `customer_email` text NOT NULL,
        `amount_cents` integer DEFAULT 0 NOT NULL,
        `due_at` integer NOT NULL,
        `status` text DEFAULT 'unpaid' NOT NULL,
        `created_at` integer NOT NULL,
        `updated_at` integer NOT NULL,
        FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invoices_business_due_idx` ON `invoices` (`business_id`,`due_at`);
