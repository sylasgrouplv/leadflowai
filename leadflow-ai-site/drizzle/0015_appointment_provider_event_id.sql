-- LeadFlow AI — Calendar provider event id persistence (task 3 of §5).
-- Mirrors drizzle/pg/0008_appointment_provider_event_id.sql (Postgres) exactly.
-- Adds a nullable provider event id to appointments so the real Google Calendar
-- provider can resolve the event for cancel/reschedule (the provider contract
-- is DB-free, so the appointment layer persists the id returned by book()).
-- Existing rows default to '' (mock / pre-migration; no fabricated ids).
ALTER TABLE `appointments` ADD `provider_event_id` text DEFAULT '';
