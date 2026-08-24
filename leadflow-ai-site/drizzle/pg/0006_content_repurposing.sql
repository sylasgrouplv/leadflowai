-- LeadFlow AI — Phase 3 / Chunk J: content repurposing (dogfooding #12).
-- Mirrors drizzle/0013_content_repurposing.sql (SQLite) exactly.
-- The in-product content model: original content pieces (case studies, KB
-- entries, posts) plus the AI-generated social drafts produced from them by
-- the `repurpose_content` WRITE tool (audited, tenant-scoped). Drafts are
-- stored with source_type 'social_draft' and source_ref = the source piece id.
-- status defaults to 'draft': publishing is a human/HIGH-RISK action — the
-- tool only ever creates drafts, never publishes.
--
-- Guarded like 0005: migration 0001 shipped businesses.id WITHOUT a primary
-- key on some prod databases (fixed idempotently in 0005). This FK needs the
-- PK, so re-assert it here (idempotent — covers fresh installs and any
-- database where 0005 was skipped; no unguarded DDL on referenced tables).
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
CREATE TABLE IF NOT EXISTS content_pieces (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_type text NOT NULL DEFAULT 'post',
  source_ref text NOT NULL DEFAULT '',
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS content_pieces_business_idx ON content_pieces (business_id, created_at);
