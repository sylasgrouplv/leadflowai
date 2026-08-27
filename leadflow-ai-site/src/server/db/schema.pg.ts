/**
 * LeadFlow AI — Postgres schema (production dialect).
 *
 * Generated from schema.sqlite.ts (the sqlite-core source of truth) — same
 * tables, same column names, same defaults. Dialect differences:
 *   - integer -> integer (small ints) / bigint { mode: "number" } (epoch-ms)
 *   - `.$type<T>()` dropped (pg text columns are plain strings at the type level)
 * The facade src/server/db/schema.ts re-exports this module when DATABASE_URL
 * is set; drizzle-kit never generates from it (migrations are hand-written in
 * drizzle/pg/).
 */
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
import { pgTable, text, integer, bigint, index, uniqueIndex } from "drizzle-orm/pg-core";

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
/** Social posting queue lifecycle (dogfooding Phase 3 / Chunk K — #13). */
export const SOCIAL_POST_STATUSES = ["pending", "posting", "posted", "failed", "cancelled"] as const;
export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number];
export const PLAN_NAMES = ["starter", "professional", "premium"] as const;
export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "canceled"] as const;
export const INVOICE_STATUSES = ["unpaid", "paid", "cancelled"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INTEGRATION_PROVIDERS = ["ai", "sms", "email", "calendar", "crm", "stripe"] as const;
export const INTEGRATION_STATUSES = ["not_configured", "connected", "mock", "error"] as const;
export const KB_KINDS = ["faq", "policy", "service_info", "general"] as const;

// ---------------------------------------------------------------------------
// Auth / org
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull().default("owner"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("users_email_idx").on(t.email)]);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("sessions_token_hash_idx").on(t.tokenHash)]);

export const businesses = pgTable("businesses", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  category: text("category").notNull().default("home_services"),
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
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const teamMembers = pgTable("team_members", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("team_members_biz_user_idx").on(t.businessId, t.userId)]);

// ---------------------------------------------------------------------------
// Lead management
// ---------------------------------------------------------------------------

export const services = pgTable("services", {
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
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [index("services_business_idx").on(t.businessId)]);

export const leads = pgTable("leads", {
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
  status: text("status").notNull().default("new"),
  score: text("score").notNull().default("cold"),
  /** Numeric 0–100 from the lead scoring rubric (spec §9–11); 0 = not yet scored. */
  scoreValue: integer("score_value").notNull().default(0),
  /** Rubric classification: HOT/WARM/COLD/UNQUALIFIED/HUMAN_REVIEW (spec §9–11). */
  classification: text("classification").notNull().default("COLD"),
  notes: text("notes").default(""),
  assignedTo: text("assigned_to").references(() => users.id),
  estimatedValueCents: integer("estimated_value_cents").notNull().default(0),
  lastContactedAt: bigint("last_contacted_at", { mode: "number" }),
  /** Lead opted out of automated follow-ups (1 = all, or channel in optOutChannel). */
  optedOut: integer("opted_out").notNull().default(0),
  optOutChannel: text("opt_out_channel").default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [
  index("leads_business_idx").on(t.businessId),
  index("leads_status_idx").on(t.businessId, t.status),
]);

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
  channel: text("channel").notNull().default("chat"),
  status: text("status").notNull().default("active"),
  aiEnabled: integer("ai_enabled").notNull().default(1),
  /** JSON: short-term conversation memory (spec §27) — customer_name, service,
   *  location, problem, urgency, appointment_intent, preferences, previous
   *  answers. Written only by the AI orchestrator, scoped to business+conversation. */
  memoryJson: text("memory_json").default("{}"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [index("conversations_business_idx").on(t.businessId)]);

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  sender: text("sender").notNull(),
  body: text("body").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [index("messages_conversation_idx").on(t.conversationId)]);

export const appointments = pgTable("appointments", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
  serviceId: text("service_id").references(() => services.id, { onDelete: "set null" }),
  startAt: bigint("start_at", { mode: "number" }).notNull(),
  endAt: bigint("end_at", { mode: "number" }).notNull(),
  status: text("status").notNull().default("booked"),
  notes: text("notes").default(""),
  // Real provider event id (Google Calendar) returned by book(); empty for the
  // mock / pre-migration rows. Used by cancel/reschedule instead of fabricating
  // a synthetic id. The provider contract is DB-free, so the appointment layer
  // persists this so the real provider can resolve the event later.
  providerEventId: text("provider_event_id").default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [index("appointments_business_idx").on(t.businessId, t.startAt)]);

// ---------------------------------------------------------------------------
// Knowledge / follow-ups / integrations / billing
// ---------------------------------------------------------------------------

export const knowledgeBase = pgTable("knowledge_base", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("faq"),
  question: text("question").default(""),
  answer: text("answer").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [index("knowledge_business_idx").on(t.businessId)]);

export const followUps = pgTable("follow_ups", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  scheduledFor: bigint("scheduled_for", { mode: "number" }).notNull(),
  templateKey: text("template_key").default(""),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [index("followups_business_idx").on(t.businessId, t.status)]);

/**
 * Per-business follow-up sequence config (spec §9 "owner-customizable").
 * stepsJson: JSON array of { step, days, type, enabled, templateKey }.
 * Default when absent: 1/3/7/14 days, sms/email/sms/email.
 */
export const followUpConfigs = pgTable("follow_up_configs", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  stepsJson: text("steps_json").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("followup_configs_business_idx").on(t.businessId)]);

/**
 * Per-business website chat widget settings (spec §14). Fields follow the
 * spec's customization list: logo, business name (from businesses.name),
 * welcome message, widget position, primary color. `enabled` gates the public
 * widget endpoints for that business.
 */
export const WIDGET_POSITIONS = ["bottom-left", "bottom-right"] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

export const widgetSettings = pgTable("widget_settings", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  enabled: integer("enabled").notNull().default(1),
  primaryColor: text("primary_color").notNull().default("#4f46e5"),
  position: text("position").notNull().default("bottom-right"),
  welcomeMessage: text("welcome_message").default(""),
  logoUrl: text("logo_url").default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("widget_settings_business_idx").on(t.businessId)]);

export const integrations = pgTable("integrations", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  /** JSON config blob (never secrets in plaintext app code). */
  configJson: text("config_json").default("{}"),
  status: text("status").notNull().default("not_configured"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("integrations_business_provider_idx").on(t.businessId, t.provider)]);

export const subscriptions = pgTable("subscriptions", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  plan: text("plan").notNull().default("starter"),
  status: text("status").notNull().default("trialing"),
  stripeCustomerId: text("stripe_customer_id").default(""),
  stripeSubscriptionId: text("stripe_subscription_id").default(""),
  currentPeriodEnd: bigint("current_period_end", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

/**
 * Invoices (dogfooding Phase 2 / Chunk H — invoice reminders, automation #10).
 * The in-product invoice model: a business bills a customer (customer_name /
 * customer_email) amount_cents due at due_at. Status: unpaid | paid | cancelled.
 * Rows are created ONLY through the `create_invoice` WRITE tool (audited,
 * tenant-scoped) which emits INVOICE_CREATED; the `invoice_reminder` default
 * rule schedules a reminder follow-up at due_at minus the business's lead time
 * (default 48h). Real Stripe billing stays deferred behind the StripeProvider
 * interface — a future payment webhook marks invoices paid via the repo
 * helpers (markInvoicePaid / markInvoiceCancelled), which also cancel any
 * pending reminder for the invoice.
 */
export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  amountCents: integer("amount_cents").notNull().default(0),
  /** Due date (epoch ms). The reminder fires at due_at − lead time. */
  dueAt: bigint("due_at", { mode: "number" }).notNull(),
  status: text("status").notNull().default("unpaid"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [index("invoices_business_due_idx").on(t.businessId, t.dueAt)]);

/**
 * Content pieces (dogfooding Phase 3 / Chunk J — content repurposing, #12).
 * The in-product content model: original content (case studies, KB entries,
 * posts) plus the AI-generated social drafts produced from them by the
 * `repurpose_content` WRITE tool (audited, tenant-scoped). Drafts are stored
 * with source_type 'social_draft' and source_ref = the source piece id. The
 * status column defaults to 'draft': publishing is a human/HIGH-RISK action —
 * the tool only ever creates drafts, never publishes.
 */
export const contentPieces = pgTable("content_pieces", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  /** case_study | kb_entry | post | testimonial | other | social_draft */
  sourceType: text("source_type").notNull().default("post"),
  /** Optional reference to the origin (e.g. a KB row id or external URL/text). */
  sourceRef: text("source_ref").notNull().default(""),
  title: text("title").notNull(),
  /** Original content (or the generated draft body for social_draft rows). */
  body: text("body").notNull(),
  /** draft | published — the AI tool only ever writes 'draft'. */
  status: text("status").notNull().default("draft"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [index("content_pieces_business_idx").on(t.businessId, t.createdAt)]);

/**
 * Social posts (dogfooding Phase 3 / Chunk K — social media scheduling, #13).
 * A per-business post queue. Rows are created ONLY by the `schedule_social_post`
 * WRITE tool (audited, tenant-scoped) or the in-app social surface route. The
 * scheduled worker (`src/server/social/engine.ts` runSocialPostScheduler, on
 * the same tick as follow-ups/BI) picks due rows (status='pending' and
 * scheduled_for <= now) and posts them through the SocialProvider interface —
 * mock by default (a clearly-labeled "post" = provider.send + set posted), a
 * real API later via SOCIAL_PROVIDER env (config-only swap). status lifecycle:
 * pending → posting → posted | failed, or cancelled for a cancelled post. Safe
 * WRITE action: audited through the tool registry, never HIGH_RISK.
 */
export const socialPosts = pgTable("social_posts", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  /** Provider name that posted this row (e.g. "mock-social"); set at post time. */
  provider: text("provider").notNull().default("mock"),
  /** facebook | instagram | linkedin | x — the destination platform. */
  platform: text("platform").notNull(),
  /** The post copy / content. */
  message: text("message").notNull(),
  /** When the post is due (epoch ms). The worker posts rows with scheduledFor <= now. */
  scheduledFor: integer("scheduled_for").notNull(),
  /** pending | posting | posted | failed | cancelled */
  status: text("status").$type<SocialPostStatus>().notNull().default("pending"),
  /** When the post was actually published (epoch ms); null until posted. */
  postedAt: integer("posted_at"),
  /** Last failure message (status='failed'); null otherwise. */
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [index("social_posts_business_due_idx").on(t.businessId, t.scheduledFor)]);

// ---------------------------------------------------------------------------
// AI agent activity / audit (safety + traceability)
// ---------------------------------------------------------------------------

export const agentActions = pgTable("agent_actions", {
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
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [index("agent_actions_business_idx").on(t.businessId, t.createdAt)]);

export const auditLogs = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  businessId: text("business_id").references(() => businesses.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entity: text("entity").default(""),
  entityId: text("entity_id").default(""),
  detailsJson: text("details_json").default("{}"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [index("audit_logs_business_idx").on(t.businessId, t.createdAt)]);

/**
 * Human escalation tasks (spec §18–20) — priority, lead_id, reason,
 * conversation_summary, recommended_action. Created by the Human Escalation
 * Manager (and by the tool registry when the AI attempts a HIGH_RISK tool).
 */
export const humanTasks = pgTable("human_tasks", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
  priority: text("priority").notNull().default("medium"),
  reason: text("reason").notNull(),
  conversationSummary: text("conversation_summary").default(""),
  recommendedAction: text("recommended_action").default(""),
  category: text("category").notNull().default("other"),
  status: text("status").notNull().default("open"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  resolvedAt: bigint("resolved_at", { mode: "number" }),
}, (t) => [index("human_tasks_business_idx").on(t.businessId, t.status)]);

export const notifications = pgTable("notifications", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  kind: text("kind").notNull().default("info"),
  title: text("title").notNull(),
  body: text("body").default(""),
  read: integer("read").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
  "INVOICE_CREATED",
  "CONTENT_REPURPOSED",
  "POST_PUBLISHED",
] as const;
export type EventType = (typeof EVENTS)[number];

export const events = pgTable("events", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
  conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  payloadJson: text("payload_json").default("{}"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [index("events_business_type_idx").on(t.businessId, t.type, t.createdAt)]);

export const AUTOMATION_RUN_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

/**
 * Automation rule definitions (spec §29): trigger_event (or "" for
 * none/scheduled), delay_ms (0 = immediate), condition_json evaluated at fire
 * time (e.g. {"type":"lead_not_booked"}, {"type":"score_gte","value":50}),
 * action + action_config_json, enabled. Rules are per-business.
 */
export const automationRules = pgTable("automation_rules", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  triggerEvent: text("trigger_event").notNull().default(""),
  delayMs: integer("delay_ms").notNull().default(0),
  conditionJson: text("condition_json").notNull().default("{}"),
  action: text("action").notNull(),
  actionConfigJson: text("action_config_json").notNull().default("{}"),
  enabled: integer("enabled").notNull().default(1),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("automation_rules_business_name_idx").on(t.businessId, t.name), index("automation_rules_trigger_idx").on(t.businessId, t.triggerEvent)]);

/**
 * Persisted run store (spec §29): one row per scheduled execution. Delayed /
 * scheduled runs survive restarts because they live in the DB — the worker
 * picks due pending runs on each tick. Status: pending → running → done |
 * failed | cancelled. attempts + last_error drive §31 retry/error handling.
 */
export const automationRuns = pgTable("automation_runs", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id").references(() => leads.id, { onDelete: "set null" }),
  ruleId: text("rule_id").references(() => automationRules.id, { onDelete: "set null" }),
  ruleKind: text("rule_kind").notNull(),
  runAt: bigint("run_at", { mode: "number" }).notNull(),
  status: text("status").notNull().default("pending"),
  payloadJson: text("payload_json").notNull().default("{}"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
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
export const reviewConfigs = pgTable("review_configs", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  enabled: integer("enabled").notNull().default(1),
  delayDays: integer("delay_days").notNull().default(1),
  reviewUrl: text("review_url").notNull().default(""),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
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
export const reviews = pgTable("reviews", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  leadId: text("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  appointmentId: text("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
  feedbackText: text("feedback_text").notNull().default(""),
  sentiment: text("sentiment").notNull().default("unknown"),
  reviewRequestSentAt: bigint("review_request_sent_at", { mode: "number" }),
  reviewLinkSentAt: bigint("review_link_sent_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
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
export const usageEvents = pgTable("usage_events", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  direction: text("direction").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
  /** JSON blob: provider name, intent, agent, template key, … */
  metaJson: text("meta_json").notNull().default("{}"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
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
export const businessReports = pgTable("business_reports", {
  id: text("id").primaryKey(),
  businessId: text("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("weekly"),
  weekStart: bigint("week_start", { mode: "number" }).notNull(),
  metricsJson: text("metrics_json").notNull().default("{}"),
  narrativeJson: text("narrative_json").notNull().default("{}"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("business_reports_biz_type_week_idx").on(t.businessId, t.type, t.weekStart)]);

// ---------------------------------------------------------------------------
// AI BRAIN 5b — platform-level settings (spec §39 admin AI control)
// ---------------------------------------------------------------------------

/**
 * Global platform settings (spec §39): one row per settings key, value stored
 * as JSON. Written ONLY by platform admins (admin@leadflow.ai) through the
 * admin-only /api/admin/ai routes — business owners can never touch these
 * (global safety rules stay platform-controlled). Keys: "agents" (global agent
 * on/off) and "defaults" (tone/responseLength/escalationSensitivity applied
 * when a business has not customized the field).
 */
export const platformSettings = pgTable("platform_settings", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  valueJson: text("value_json").notNull().default("{}"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (t) => [uniqueIndex("platform_settings_key_idx").on(t.key)]);
