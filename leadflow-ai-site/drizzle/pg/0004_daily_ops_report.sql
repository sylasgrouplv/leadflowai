-- LeadFlow AI — Phase 2 / Chunk G: daily ops report (dogfooding #9).
-- Mirrors drizzle/0011_daily_ops_report.sql (SQLite) exactly.
-- Adds a type discriminator to business_reports so daily reports (type='daily',
-- week_start = day start, midnight UTC) coexist with weekly reports
-- (type='weekly', week_start = Monday 00:00 UTC). The unique index becomes
-- (business_id, type, week_start) so a daily report for a Monday can live
-- alongside that week's weekly report. Existing rows get type='weekly'.
--
ALTER TABLE business_reports ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'weekly';
DROP INDEX IF EXISTS business_reports_biz_week_idx;
CREATE UNIQUE INDEX IF NOT EXISTS business_reports_biz_type_week_idx ON business_reports (business_id, type, week_start);
