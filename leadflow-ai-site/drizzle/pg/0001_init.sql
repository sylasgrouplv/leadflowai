-- LeadFlow AI — Postgres schema (hand-tracked; drizzle-kit generate is broken in this repo).
-- Mirrors drizzle/0000..0008 (SQLite) exactly: same tables, columns, defaults, indexes.
--
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agent_actions (
  id text NOT NULL,
  business_id text NOT NULL,
  agent text NOT NULL DEFAULT 'receptionist',
  action text NOT NULL,
  lead_id text,
  input_json text DEFAULT '{}',
  result_json text DEFAULT '{}',
  success integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id text NOT NULL,
  business_id text NOT NULL,
  lead_id text,
  service_id text,
  start_at bigint NOT NULL,
  end_at bigint NOT NULL,
  status text NOT NULL DEFAULT 'booked',
  notes text DEFAULT '',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id text NOT NULL,
  business_id text,
  user_id text,
  action text NOT NULL,
  entity text DEFAULT '',
  entity_id text DEFAULT '',
  details_json text DEFAULT '{}',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id text NOT NULL,
  business_id text NOT NULL,
  name text NOT NULL,
  trigger_event text NOT NULL DEFAULT '',
  delay_ms integer NOT NULL DEFAULT 0,
  condition_json text NOT NULL DEFAULT '{}',
  action text NOT NULL,
  action_config_json text NOT NULL DEFAULT '{}',
  enabled integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id text NOT NULL,
  business_id text NOT NULL,
  lead_id text,
  rule_id text,
  rule_kind text NOT NULL,
  run_at bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  payload_json text NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0,
  last_error text NOT NULL DEFAULT '',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS business_reports (
  id text NOT NULL,
  business_id text NOT NULL,
  week_start bigint NOT NULL,
  metrics_json text NOT NULL DEFAULT '{}',
  narrative_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS businesses (
  id text NOT NULL,
  owner_id text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'home_services',
  phone text DEFAULT '',
  email text DEFAULT '',
  website text DEFAULT '',
  description text DEFAULT '',
  service_area_json text DEFAULT '{}',
  hours_json text DEFAULT '{}',
  policies_json text DEFAULT '{}',
  ai_config_json text DEFAULT '{}',
  onboarding_step integer NOT NULL DEFAULT 1,
  onboarding_completed integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id text NOT NULL,
  business_id text NOT NULL,
  lead_id text,
  channel text NOT NULL DEFAULT 'chat',
  status text NOT NULL DEFAULT 'active',
  ai_enabled integer NOT NULL DEFAULT 1,
  memory_json text DEFAULT '{}',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id text NOT NULL,
  business_id text NOT NULL,
  type text NOT NULL,
  lead_id text,
  conversation_id text,
  payload_json text DEFAULT '{}',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_up_configs (
  id text NOT NULL,
  business_id text NOT NULL,
  steps_json text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id text NOT NULL,
  business_id text NOT NULL,
  lead_id text NOT NULL,
  type text NOT NULL,
  scheduled_for bigint NOT NULL,
  template_key text DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS human_tasks (
  id text NOT NULL,
  business_id text NOT NULL,
  lead_id text,
  priority text NOT NULL DEFAULT 'medium',
  reason text NOT NULL,
  conversation_summary text DEFAULT '',
  recommended_action text DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  resolved_at bigint
);

CREATE TABLE IF NOT EXISTS integrations (
  id text NOT NULL,
  business_id text NOT NULL,
  provider text NOT NULL,
  config_json text DEFAULT '{}',
  status text NOT NULL DEFAULT 'not_configured',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_base (
  id text NOT NULL,
  business_id text NOT NULL,
  kind text NOT NULL DEFAULT 'faq',
  question text DEFAULT '',
  answer text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id text NOT NULL,
  business_id text NOT NULL,
  first_name text NOT NULL,
  last_name text DEFAULT '',
  phone text DEFAULT '',
  email text DEFAULT '',
  source text DEFAULT 'website_chat',
  service_requested text DEFAULT '',
  location text DEFAULT '',
  status text NOT NULL DEFAULT 'new',
  score text NOT NULL DEFAULT 'cold',
  score_value integer NOT NULL DEFAULT 0,
  classification text NOT NULL DEFAULT 'COLD',
  notes text DEFAULT '',
  assigned_to text,
  estimated_value_cents integer NOT NULL DEFAULT 0,
  last_contacted_at bigint,
  opted_out integer NOT NULL DEFAULT 0,
  opt_out_channel text DEFAULT '',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id text NOT NULL,
  business_id text NOT NULL,
  conversation_id text NOT NULL,
  sender text NOT NULL,
  body text NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id text NOT NULL,
  business_id text NOT NULL,
  user_id text,
  kind text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  body text DEFAULT '',
  read integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS review_configs (
  id text NOT NULL,
  business_id text NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  delay_days integer NOT NULL DEFAULT 1,
  review_url text NOT NULL DEFAULT '',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id text NOT NULL,
  business_id text NOT NULL,
  lead_id text NOT NULL,
  appointment_id text,
  feedback_text text NOT NULL DEFAULT '',
  sentiment text NOT NULL DEFAULT 'unknown',
  review_request_sent_at bigint,
  review_link_sent_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id text NOT NULL,
  business_id text NOT NULL,
  name text NOT NULL,
  description text DEFAULT '',
  price_cents integer NOT NULL DEFAULT 0,
  duration_min integer NOT NULL DEFAULT 60,
  average_value_cents integer NOT NULL DEFAULT 0,
  active integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id text NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id text NOT NULL,
  business_id text NOT NULL,
  plan text NOT NULL DEFAULT 'starter',
  status text NOT NULL DEFAULT 'trialing',
  stripe_customer_id text DEFAULT '',
  stripe_subscription_id text DEFAULT '',
  current_period_end bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  id text NOT NULL,
  business_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id text NOT NULL,
  business_id text NOT NULL,
  kind text NOT NULL,
  direction text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  estimated_cost_cents integer NOT NULL DEFAULT 0,
  meta_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'owner',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS widget_settings (
  id text NOT NULL,
  business_id text NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  primary_color text NOT NULL DEFAULT '#4f46e5',
  position text NOT NULL DEFAULT 'bottom-right',
  welcome_message text DEFAULT '',
  logo_url text DEFAULT '',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_actions_business_idx ON agent_actions (business_id,created_at);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS appointments_business_idx ON appointments (business_id,start_at);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS audit_logs_business_idx ON audit_logs (business_id,created_at);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS automation_rules_trigger_idx ON automation_rules (business_id,trigger_event);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS automation_runs_business_status_idx ON automation_runs (business_id,status,run_at);
CREATE INDEX IF NOT EXISTS conversations_business_idx ON conversations (business_id);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS events_business_type_idx ON events (business_id,type,created_at);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS followups_business_idx ON follow_ups (business_id,status);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS human_tasks_business_idx ON human_tasks (business_id,status);
CREATE INDEX IF NOT EXISTS knowledge_business_idx ON knowledge_base (business_id);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS leads_business_idx ON leads (business_id);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (business_id,status);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS notifications_business_idx ON notifications (business_id,read);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS reviews_business_idx ON reviews (business_id,created_at);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS reviews_business_sentiment_idx ON reviews (business_id,sentiment);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS services_business_idx ON services (business_id);--> statement-breakpoint;
CREATE INDEX IF NOT EXISTS usage_events_business_created_idx ON usage_events (business_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS automation_rules_business_name_idx ON automation_rules (business_id,name);--> statement-breakpoint;
CREATE UNIQUE INDEX IF NOT EXISTS business_reports_biz_week_idx ON business_reports (business_id,week_start);
CREATE UNIQUE INDEX IF NOT EXISTS followup_configs_business_idx ON follow_up_configs (business_id);--> statement-breakpoint;
CREATE UNIQUE INDEX IF NOT EXISTS integrations_business_provider_idx ON integrations (business_id,provider);--> statement-breakpoint;
CREATE UNIQUE INDEX IF NOT EXISTS review_configs_business_idx ON review_configs (business_id);--> statement-breakpoint;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions (token_hash);--> statement-breakpoint;
CREATE UNIQUE INDEX IF NOT EXISTS team_members_biz_user_idx ON team_members (business_id,user_id);--> statement-breakpoint;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS widget_settings_business_idx ON widget_settings (business_id);

-- Migration ledger (tiny tracked migrator applies files in drizzle/pg/).
CREATE TABLE IF NOT EXISTS drizzle_migrations (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  applied_at timestamptz NOT NULL DEFAULT now()
);
