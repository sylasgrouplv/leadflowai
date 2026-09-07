-- LeadFlow AI — HubSpot ↔ ctomail two-way sync (Phase 1 task 2).
-- Mirrors drizzle/pg/0009_sync_state.sql (Postgres) exactly.
-- Per-direction sync cursor/watermark state for CRM connectors. One row per
-- (provider, direction, entity):
--   last_sync_at = wall clock of the last completed run (epoch ms),
--   last_cursor  = provider watermark — epoch-ms string for timestamp
--                  watermarks, or an opaque token for keyset/paging cursors
--                  (text so either fits),
--   status       = idle | ok | error,
--   error        = last failure message (null when ok),
--   meta_json    = small run-counters blob (pushed/pulled/skipped/errors).
-- NOT business-scoped: the HubSpot portal is a company-level resource (one
-- portal holds records for several tenants — see hubspot-import.ts), so the
-- cursors live at portal level. The polling job (src/server/crm/sync.ts)
-- reads the watermark, processes changes strictly after it through idempotent
-- upserts, then advances it — safe to run repeatedly.
CREATE TABLE `sync_state` (
        `id` text PRIMARY KEY NOT NULL,
        `provider` text NOT NULL,
        `direction` text NOT NULL,
        `entity` text NOT NULL,
        `last_sync_at` integer,
        `last_cursor` text,
        `status` text DEFAULT 'idle' NOT NULL,
        `error` text,
        `meta_json` text DEFAULT '{}' NOT NULL,
        `created_at` integer NOT NULL,
        `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_state_provider_direction_entity_idx` ON `sync_state` (`provider`,`direction`,`entity`);
