/**
 * LeadFlow AI — database schema.
 *
 * Written with Postgres portability in mind:
 *   - all ids are TEXT (uuid)
 *   - all timestamps are INTEGER unix epoch milliseconds
 *   - booleans are INTEGER 0/1
 *   - enums are TEXT (validated in the app layer with zod)
 *   - money is INTEGER cents
 *   - JSON blobs are TEXT (JSON.stringify)
 *
 * Swapping to Postgres later = change the driver in db/client.ts and the
 * dialect import (sqlite-core -> pg-core); column definitions carry over
 * almost verbatim. Every business-owned table carries business_id and every
 * query path goes through src/server/db/repo.ts which enforces the tenant
 * filter (see repo.ts).
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const USER_ROLES = ["admin", "owner", "employee"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "appointment_booked",
  "customer",
  "lost",
  "unqualified",
  "needs_human",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Follow-up opt-out marker: lead asked to stop being contacted (spec §9 stop rule). */
export const OPT_OUT_CHANNELS = ["sms", "email", "all"] as const;
export type OptOutChannel = (typeof OPT_OUT_CHANNELS)[number] | "";

export const LEAD_SCORES = ["hot", "warm", "cold"] as const;
export type LeadScore = (typeof LEAD_SCORES)[number];

/**
 * 0–100 rubric classification (spec §9–11): HOT / WARM / COLD plus
 * UNQUALIFIED (outside service area) and HUMAN_REVIEW (escalation context).
 * `leads.score` (hot/warm/cold) stays the UI badge; `classification` is the
 * full rubric result and `score_value` the numeric 0–100.
 */
export const LEAD_CLASSIFICATIONS = ["HOT", "WARM", "COLD", "UNQUALIFIED", "HUMAN_REVIEW"] as const;
export type LeadClassification = (typeof LEAD_CLASSIFICATIONS)[number];

export const HUMAN_TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type HumanTaskPriority = (typeof HUMAN_TASK_PRIORITIES)[number];
export const HUMAN_TASK_STATUSES = ["open", "resolved"] as const;
export type HumanTaskStatus = (typeof HUMAN_TASK_STATUSES)[number];

export const APP_TYPES = [
  "hvac",
  "plumbing",
  "roofing",
  "landscaping",
  "cleaning",
  "auto_repair",
  "restoration",
  "home_services",
  "other",
] as const;
export type BusinessCategory = (typeof APP_TYPES)[number];

export const CONVERSATION_STATUSES = ["active", "ai_handling", "human_takeover", "closed"] as const;
export const MESSAGE_SENDERS = ["ai", "lead", "employee", "system"] as const;
export const APPOINTMENT_STATUSES = ["booked", "confirmed", "completed", "cancelled", "no_show"] as const;
export const FOLLOWUP_TYPES = ["sms", "email"] as const;
export const FOLLOWUP_STATUSES = ["pending", "sent", "skipped", "cancelled", "paused"] as const;
export const PLAN_NAMES = ["starter", "professional", "premium"] as const;
export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "canceled"] as const;
export const INTEGRATION_PROVIDERS = ["ai", "sms", "email", "calendar", "crm", "stripe"] as const;
export const INTEGRATION_STATUSES = ["not_configured", "connected", "mock", "error"] as const;
export const KB_KINDS = ["faq", "policy", "service_info", "general"] as const;

// ---------------------------------------------------------------------------
// Auth / org
// ---------------------------------------------------------------------------

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").$type<UserRole>().notNull().default("owner"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("users_email_idx").on(t.email)]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("sessions_token_hash_idx").on(t.tokenHash)]);

export const businesses = sqliteTable("businesses", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  category: text("category").$type<BusinessCategory>().notNull().default("home_services"),
  phone: text("phone").default(""),
  email: text("email").default(""),
  website: text("website").default(""),
  description: text("description").default(""),
  /** JSON: { zipCodes: string[], cities: string[] } */
  serviceAreaJson: text("service_area_json").default("{}"),
  /** JSON: { monday: { open, close, closed }, ... } */
  hoursJson: text("hours_json").default("{}"),
  /** JSON: { cancellationPolicy, financing, promotions, welcomeMessage } */
  policiesJson: text("policies_json").default("{}"),
  /** JSON: { autoRespond, escalationSensitivity, escalationKeywords } — AI agent config (spec §6, §13) */
  aiConfigJson: text("ai_config_json").default("{}"),
  /** Next onboarding step to complete: 1..5, 6 = complete. */
  onboardingStep: integer("onboarding_step").notNull().default(1),
  onboardingCompleted: integer("onboarding_completed").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const teamMembers = sqliteTable("team_members", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: text("role").$type<UserRole>().notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("team_members_biz_user_idx").on(t.businessId, t.userId)]);

// ---------------------------------------------------------------------------
// Lead management
// ---------------------------------------------------------------------------

export const services = sqliteTable("services", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").default(""),
  priceCents: integer("price_cents").notNull().default(0),
  /** 0 = "call for pricing" */
  durationMin: integer("duration_min").notNull().default(60),
  /**
   * Revenue attribution (spec §23): the owner-configured average job value for
   * this service. 0 = not configured → fall back to priceCents. Used for the
   * "Estimated Revenue" figures (booked/completed jobs × configured value) —
   * always labeled as estimates, never presented as actuals.
   */
  averageValueCents: integer("average_value_cents").notNull().default(0),
  active: integer("active").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("services_business_idx").on(t.businessId)]);

export const leads = sqliteTable("leads", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").default(""),
  phone: text("phone").default(""),
  email: text("email").default(""),
  source: text("source").default("website_chat"),
  serviceRequested: text("service_requested").default(""),
  location: text("location").default(""),
  status: text("status").$type<LeadStatus>().notNull().default("new"),
  score: text("score").$type<LeadScore>().notNull().default("cold"),
  /** Numeric 0–100 from the lead scoring rubric (spec §9–11); 0 = not yet scored. */
  scoreValue: integer("score_value").notNull().default(0),
  /** Rubric classification: HOT/WARM/COLD/UNQUALIFIED/HUMAN_REVIEW (spec §9–11). */
  classification: text("classification").$type<LeadClassification>().notNull().default("COLD"),
  notes: text("notes").default(""),
  assignedTo: text("assigned_to").references(() => users.id),
  estimatedValueCents: integer("estimated_value_cents").notNull().default(0),
  lastContactedAt: integer("last_contacted_at"),
  /** Lead opted out of automated follow-ups (1 = all, or channel in optOutChannel). */
  optedOut: integer("opted_out").notNull().default(0),
  optOutChannel: text("opt_out_channel").$type<OptOutChannel>().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  index("leads_business_idx").on(t.businessId),
  index("leads_status_idx").on(t.businessId, t.status),
]);

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
  channel: text("channel").notNull().default("chat"),
  status: text("status").$type<(typeof CONVERSATION_STATUSES)[number]>().notNull().default("active"),
  aiEnabled: integer("ai_enabled").notNull().default(1),
  /** JSON: short-term conversation memory (spec §27) — customer_name, service,
   *  location, problem, urgency, appointment_intent, preferences, previous
   *  answers. Written only by the AI orchestrator, scoped to business+conversation. */
  memoryJson: text("memory_json").default("{}"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("conversations_business_idx").on(t.businessId)]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  sender: text("sender").$type<(typeof MESSAGE_SENDERS)[number]>().notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("messages_conversation_idx").on(t.conversationId)]);

export const appointments = sqliteTable("appointments", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
  serviceId: text("service_id").references(() => services.id, { onDelete: "set null" }),
  startAt: integer("start_at").notNull(),
  endAt: integer("end_at").notNull(),
  status: text("status").$type<(typeof APPOINTMENT_STATUSES)[number]>().notNull().default("booked"),
  notes: text("notes").default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("appointments_business_idx").on(t.businessId, t.startAt)]);

// ---------------------------------------------------------------------------
// Knowledge / follow-ups / integrations / billing
// ---------------------------------------------------------------------------

export const knowledgeBase = sqliteTable("knowledge_base", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  kind: text("kind").$type<(typeof KB_KINDS)[number]>().notNull().default("faq"),
  question: text("question").default(""),
  answer: text("answer").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("knowledge_business_idx").on(t.businessId)]);

export const followUps = sqliteTable("follow_ups", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  type: text("type").$type<(typeof FOLLOWUP_TYPES)[number]>().notNull(),
  scheduledFor: integer("scheduled_for").notNull(),
  templateKey: text("template_key").default(""),
  status: text("status").$type<(typeof FOLLOWUP_STATUSES)[number]>().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("followups_business_idx").on(t.businessId, t.status)]);

/**
 * Per-business follow-up sequence config (spec §9 "owner-customizable").
 * stepsJson: JSON array of { step, days, type, enabled, templateKey }.
 * Default when absent: 1/3/7/14 days, sms/email/sms/email.
 */
export const followUpConfigs = sqliteTable("follow_up_configs", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  stepsJson: text("steps_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("followup_configs_business_idx").on(t.businessId)]);

/**
 * Per-business website chat widget settings (spec §14). Fields follow the
 * spec's customization list: logo, business name (from businesses.name),
 * welcome message, widget position, primary color. `enabled` gates the public
 * widget endpoints for that business.
 */
export const WIDGET_POSITIONS = ["bottom-left", "bottom-right"] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

export const widgetSettings = sqliteTable("widget_settings", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  enabled: integer("enabled").notNull().default(1),
  primaryColor: text("primary_color").notNull().default("#4f46e5"),
  position: text("position").$type<WidgetPosition>().notNull().default("bottom-right"),
  welcomeMessage: text("welcome_message").default(""),
  logoUrl: text("logo_url").default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("widget_settings_business_idx").on(t.businessId)]);

export const integrations = sqliteTable("integrations", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  provider: text("provider").$type<(typeof INTEGRATION_PROVIDERS)[number]>().notNull(),
  /** JSON config blob (never secrets in plaintext app code). */
  configJson: text("config_json").default("{}"),
  status: text("status").$type<(typeof INTEGRATION_STATUSES)[number]>().notNull().default("not_configured"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("integrations_business_provider_idx").on(t.businessId, t.provider)]);

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  plan: text("plan").$type<(typeof PLAN_NAMES)[number]>().notNull().default("starter"),
  status: text("status").$type<(typeof SUBSCRIPTION_STATUSES)[number]>().notNull().default("trialing"),
  stripeCustomerId: text("stripe_customer_id").default(""),
  stripeSubscriptionId: text("stripe_subscription_id").default(""),
  currentPeriodEnd: integer("current_period_end"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// AI agent activity / audit (safety + traceability)
// ---------------------------------------------------------------------------

export const agentActions = sqliteTable("agent_actions", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  agent: text("agent").notNull().default("receptionist"),
  action: text("action").notNull(),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
  inputJson: text("input_json").default("{}"),
  resultJson: text("result_json").default("{}"),
  success: integer("success").notNull().default(1),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("agent_actions_business_idx").on(t.businessId, t.createdAt)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  businessId: text("business_id").references(() => businesses.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entity: text("entity").default(""),
  entityId: text("entity_id").default(""),
  detailsJson: text("details_json").default("{}"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("audit_logs_business_idx").on(t.businessId, t.createdAt)]);

/**
 * Human escalation tasks (spec §18–20) — priority, lead_id, reason,
 * conversation_summary, recommended_action. Created by the Human Escalation
 * Manager (and by the tool registry when the AI attempts a HIGH_RISK tool).
 */
export const humanTasks = sqliteTable("human_tasks", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
  priority: text("priority").$type<HumanTaskPriority>().notNull().default("medium"),
  reason: text("reason").notNull(),
  conversationSummary: text("conversation_summary").default(""),
  recommendedAction: text("recommended_action").default(""),
  category: text("category").notNull().default("other"),
  status: text("status").$type<HumanTaskStatus>().notNull().default("open"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  resolvedAt: integer("resolved_at"),
}, (t) => [index("human_tasks_business_idx").on(t.businessId, t.status)]);

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  kind: text("kind").notNull().default("info"),
  title: text("title").notNull(),
  body: text("body").default(""),
  read: integer("read").notNull().default(0),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("notifications_business_idx").on(t.businessId, t.read)]);

// ---------------------------------------------------------------------------
// AI BRAIN 3 — event system (spec §30) + automation engine (spec §29)
// ---------------------------------------------------------------------------

/**
 * Domain events (spec §30): the internal event bus. Every row carries
 * business_id (tenant isolation — spec §33), lead_id / conversation_id when
 * applicable, a payload JSON blob, and a timestamp. Events are persisted for
 * observability and drive the automation engine: emitting an event
 * materializes runs for every matching enabled rule.
 */
export const EVENTS = [
  "LEAD_CREATED",
  "LEAD_UPDATED",
  "MESSAGE_RECEIVED",
  "MESSAGE_SENT",
  "LEAD_QUALIFIED",
  "APPOINTMENT_REQUESTED",
  "APPOINTMENT_BOOKED",
  "APPOINTMENT_CANCELLED",
  "JOB_COMPLETED",
  "FOLLOWUP_DUE",
  "FOLLOWUP_SENT",
  "CUSTOMER_OPTED_OUT",
  "HUMAN_ESCALATION",
  "REVIEW_REQUESTED",
  "BUSINESS_CREATED",
] as const;
export type EventType = (typeof EVENTS)[number];

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  type: text("type").$type<EventType>().notNull(),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
  conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  payloadJson: text("payload_json").default("{}"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("events_business_type_idx").on(t.businessId, t.type, t.createdAt)]);

export const AUTOMATION_RUN_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

/**
 * Automation rule definitions (spec §29): trigger_event (or "" for
 * none/scheduled), delay_ms (0 = immediate), condition_json evaluated at fire
 * time (e.g. {"type":"lead_not_booked"}, {"type":"score_gte","value":50}),
 * action + action_config_json, enabled. Rules are per-business.
 */
export const automationRules = sqliteTable("automation_rules", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  triggerEvent: text("trigger_event").$type<EventType | "">().notNull().default(""),
  delayMs: integer("delay_ms").notNull().default(0),
  conditionJson: text("condition_json").notNull().default("{}"),
  action: text("action").notNull(),
  actionConfigJson: text("action_config_json").notNull().default("{}"),
  enabled: integer("enabled").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("automation_rules_business_name_idx").on(t.businessId, t.name), index("automation_rules_trigger_idx").on(t.businessId, t.triggerEvent)]);

/**
 * Persisted run store (spec §29): one row per scheduled execution. Delayed /
 * scheduled runs survive restarts because they live in the DB — the worker
 * picks due pending runs on each tick. Status: pending → running → done |
 * failed | cancelled. attempts + last_error drive §31 retry/error handling.
 */
export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
  ruleId: text("rule_id").references(() => automationRules.id, { onDelete: "set null" }),
  ruleKind: text("rule_kind").notNull(),
  runAt: integer("run_at").notNull(),
  status: text("status").$type<AutomationRunStatus>().notNull().default("pending"),
  payloadJson: text("payload_json").notNull().default("{}"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("automation_runs_business_status_idx").on(t.businessId, t.status, t.runAt)]);

// ---------------------------------------------------------------------------
// AI BRAIN 4 — review agent (spec §21), business intelligence weekly reports
// (spec §22), revenue attribution (spec §23)
// ---------------------------------------------------------------------------

/**
 * Per-business review workflow config (spec §21). delay_days = how long after
 * JOB_COMPLETED the feedback request is sent (default 1 day); review_url = the
 * business's public review link sent only after POSITIVE feedback; enabled
 * turns the whole flow off for a business. Editable in Settings/Integrations.
 */
export const reviewConfigs = sqliteTable("review_configs", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  enabled: integer("enabled").notNull().default(1),
  delayDays: integer("delay_days").notNull().default(1),
  reviewUrl: text("review_url").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("review_configs_business_idx").on(t.businessId)]);

export const REVIEW_SENTIMENTS = ["positive", "negative", "unknown"] as const;
export type ReviewSentiment = (typeof REVIEW_SENTIMENTS)[number];

/**
 * Customer feedback records (spec §21): one row per completed job's review
 * flow. review_request_sent_at = when the feedback request went out (SMS/email
 * via the registry, audited); feedback_text + sentiment = the customer's reply
 * (reply channel: conversation message endpoint or POST /api/reviews/feedback);
 * review_link_sent_at = set ONLY after positive feedback (never for negative).
 */
export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  appointmentId: text("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
  feedbackText: text("feedback_text").notNull().default(""),
  sentiment: text("sentiment").$type<ReviewSentiment>().notNull().default("unknown"),
  reviewRequestSentAt: integer("review_request_sent_at"),
  reviewLinkSentAt: integer("review_link_sent_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("reviews_business_idx").on(t.businessId, t.createdAt), index("reviews_business_sentiment_idx").on(t.businessId, t.sentiment)]);
// ---------------------------------------------------------------------------
// AI BRAIN 5a — per-business usage & cost tracking (spec §32)
// ---------------------------------------------------------------------------

export const USAGE_KINDS = ["ai_message", "sms", "voice"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];
export const USAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type UsageDirection = (typeof USAGE_DIRECTIONS)[number];

/**
 * Per-business usage events (spec §32): one row per AI reply / SMS send /
 * (future) voice call. `input_tokens` + `output_tokens` are the deterministic
 * token counts reported by the AI provider (mock today, real LLM later);
 * `estimated_cost_cents` is the provider-reported or fixed per-message cost
 * estimate — always an estimate, never a bill. The monthly rollup (repo
 * getMonthlyUsage) drives the 80/90/100% budget alerts and the runaway-stop.
 * Rows are created ONLY through the record_usage tool (audited, tenant-scoped).
 */
export const usageEvents = sqliteTable("usage_events", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  kind: text("kind").$type<UsageKind>().notNull(),
  direction: text("direction").$type<UsageDirection>().notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
  /** JSON blob: provider name, intent, agent, template key, … */
  metaJson: text("meta_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("usage_events_business_created_idx").on(t.businessId, t.createdAt)]);



/**
 * Business Intelligence reports (spec §22): deterministic aggregation of a
 * business's real rows plus a mock-LLM narrative (summary / wins / problems /
 * opportunities / recommended actions). Stored so history persists and the
 * Analytics page can list them.
 *   - type 'weekly' (default): one row per week (week_start = Monday 00:00 UTC).
 *   - type 'daily'  (dogfooding #9): daily ops report — one row per day
 *     (week_start holds the day start, midnight UTC; see bi/outreach.ts).
 * (business_id, type, week_start) is unique per business, so a daily report
 * for a Monday can coexist with that week's weekly report.
 */
export const businessReports = sqliteTable("business_reports", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("weekly"),
  weekStart: integer("week_start").notNull(),
  metricsJson: text("metrics_json").notNull().default("{}"),
  narrativeJson: text("narrative_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("business_reports_biz_type_week_idx").on(t.businessId, t.type, t.weekStart)]);

// ---------------------------------------------------------------------------
// AI BRAIN 5b — platform-level settings (spec §39 admin AI control)
// ---------------------------------------------------------------------------

/**
 * Global platform settings (spec §39): one row per settings key, value stored
 * as JSON. Written ONLY by platform admins (admin@leadflow.ai) through the
 * admin-only /api/admin/ai routes — business owners can never touch these
 * (global safety rules stay platform-controlled).
 *
 * Keys:
 *   "agents"   -> { receptionist, qualification, appointment, followup,
 *                  review, bi, escalation: boolean } — global agent on/off.
 *   "defaults" -> { tone, responseLength, escalationSensitivity } — global
 *                  defaults applied when a business has not customized the
 *                  field (spec §39 "global defaults").
 */
export const platformSettings = sqliteTable("platform_settings", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  valueJson: text("value_json").notNull().default("{}"),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("platform_settings_key_idx").on(t.key)]);
