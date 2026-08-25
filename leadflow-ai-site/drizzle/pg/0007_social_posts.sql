-- LeadFlow AI — Phase 3 / Chunk K: social media scheduling (dogfooding #13).
-- Mirrors drizzle/0014_social_posts.sql (SQLite) exactly.
-- A per-business social post queue. Rows are created ONLY by the
-- `schedule_social_post` WRITE tool (audited, tenant-scoped) or the in-app
-- social route (routes/social.ts). The scheduled worker
-- (src/server/social/engine.ts runSocialPostScheduler, on the same tick as
-- follow-ups/BI) picks due rows (status='pending' and scheduled_for <= now)
-- and posts them through the SocialProvider interface — mock by default (a
-- clearly-labeled sample publish), a real API later via SOCIAL_PROVIDER env
-- (config-only swap). status lifecycle: pending → posting → posted | failed,
-- or cancelled. Safe WRITE action (never HIGH_RISK).
--
-- Guarded like 0005/0006: migration 0001 shipped businesses.id WITHOUT a
-- primary key on some prod databases (fixed idempotently in 0005). This FK
-- needs the PK, so re-assert it here (idempotent — covers fresh installs and
-- any database where 0005 was skipped; no unguarded DDL on referenced tables).
DO $LF$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'businesses'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE businesses ADD PRIMARY KEY (id);
  END IF;
END $LF$;
--> statement-breakpoint;
CREATE TABLE IF NOT EXISTS social_posts (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'mock',
  platform text NOT NULL,
  message text NOT NULL,
  scheduled_for bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  posted_at bigint,
  error text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS social_posts_business_due_idx ON social_posts (business_id, scheduled_for);
