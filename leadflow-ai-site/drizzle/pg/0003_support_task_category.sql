-- LeadFlow AI — Phase 2 / Chunk F: support task categorization (dogfooding #7).
-- Mirrors drizzle/0010_support_task_category.sql (SQLite) exactly.
-- Deterministic classifier in src/server/support/agent.ts writes this column;
-- values: billing | technical | emergency | complaint | other (default other).
--
ALTER TABLE human_tasks ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'other';
