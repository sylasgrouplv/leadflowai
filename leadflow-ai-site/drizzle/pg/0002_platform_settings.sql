-- LeadFlow AI — AI BRAIN 5b: platform-level settings (spec §39 admin AI control).
-- Mirrors drizzle/0009_platform_settings.sql (SQLite) exactly.
-- Written ONLY by platform admins via the admin-only /api/admin/ai routes.
--
CREATE TABLE IF NOT EXISTS platform_settings (
  id text NOT NULL,
  key text NOT NULL,
  value_json text NOT NULL DEFAULT '{}',
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_settings_key_idx ON platform_settings (key);
