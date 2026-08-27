-- LeadFlow AI — Calendar provider event id persistence (task 3 of §5).
-- Mirrors drizzle/0015_appointment_provider_event_id.sql (SQLite) exactly.
-- Adds a nullable provider event id to appointments so the real Google Calendar
-- provider can resolve the event for cancel/reschedule (the provider contract
-- is DB-free, so the appointment layer persists the id returned by book()).
-- Existing rows default to '' (mock / pre-migration; no fabricated ids).
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS provider_event_id text DEFAULT '';
