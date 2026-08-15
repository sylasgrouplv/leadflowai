-- LeadFlow AI — Phase 2 / Chunk H: invoice reminders (dogfooding #10).
-- Mirrors drizzle/0012_invoice_reminders.sql (SQLite) exactly.
-- The in-product invoice model: a business bills a customer (customer_name /
-- customer_email) amount_cents due at due_at. Status: unpaid | paid | cancelled.
-- Rows are created ONLY through the create_invoice WRITE tool which emits
-- INVOICE_CREATED; the invoice_reminder default rule schedules a reminder at
-- due_at minus the business's lead time (default 48h). Real Stripe billing
-- stays deferred behind the StripeProvider interface — a future payment
-- webhook marks invoices paid/cancelled via the repo helpers.
--
-- PROD FIX (2026-08-15): migration 0001 shipped businesses.id WITHOUT a
-- primary key even though schema.pg.ts declares it primaryKey(), so the FK
-- below failed on Postgres with 42830 ("no unique constraint matching given
-- keys for referenced table businesses") and every /api/* call 500ed at
-- boot-time migration. Add the PK idempotently (guarded) so the FK resolves
-- on both already-migrated prod databases and fresh installs.
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
CREATE TABLE IF NOT EXISTS invoices (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  amount_cents integer NOT NULL DEFAULT 0,
  due_at bigint NOT NULL,
  status text NOT NULL DEFAULT 'unpaid',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS invoices_business_due_idx ON invoices (business_id, due_at);
