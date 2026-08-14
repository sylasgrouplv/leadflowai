ALTER TABLE `business_reports` ADD COLUMN `type` text DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `business_reports_biz_week_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `business_reports_biz_type_week_idx` ON `business_reports` (`business_id`,`type`,`week_start`);
