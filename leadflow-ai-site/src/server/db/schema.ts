/**
 * LeadFlow AI — schema facade (dialect-aware).
 *
 * Re-exports ONE schema module depending on the runtime environment:
 *   - DATABASE_URL set      -> ./schema.pg (Postgres, production/Neon)
 *   - no DATABASE_URL       -> ./schema.sqlite (SQLite, local dev fallback)
 *
 * Every consumer (`import * as s from "../db/schema"` or named imports) keeps
 * working unchanged: at runtime the exported tables are the ACTIVE dialect's
 * tables (so drizzle clients always see matching table metadata), and at the
 * type level each table is the union of both variants (identical shapes —
 * text/integer/bigint-as-number), which keeps repo.ts and the routes compiling
 * against either. The const/type exports are identical in both modules.
 */
import { env } from "../env";
import * as sqlite from "./schema.sqlite";
import * as pg from "./schema.pg";

/** True when the process is running against Postgres (DATABASE_URL set). */
export const isPostgres = env.databaseUrl.startsWith("postgres");
/** The active schema module — the one the current client was built with. */
export const activeSchema = isPostgres ? pg : sqlite;

// --- tables (union-typed; runtime value = active dialect) -------------------
export const users = activeSchema.users;
export const sessions = activeSchema.sessions;
export const businesses = activeSchema.businesses;
export const teamMembers = activeSchema.teamMembers;
export const services = activeSchema.services;
export const leads = activeSchema.leads;
export const conversations = activeSchema.conversations;
export const messages = activeSchema.messages;
export const appointments = activeSchema.appointments;
export const knowledgeBase = activeSchema.knowledgeBase;
export const followUps = activeSchema.followUps;
export const followUpConfigs = activeSchema.followUpConfigs;
export const widgetSettings = activeSchema.widgetSettings;
export const integrations = activeSchema.integrations;
export const subscriptions = activeSchema.subscriptions;
export const invoices = activeSchema.invoices;
export const contentPieces = activeSchema.contentPieces;
export const agentActions = activeSchema.agentActions;
export const auditLogs = activeSchema.auditLogs;
export const humanTasks = activeSchema.humanTasks;
export const notifications = activeSchema.notifications;
export const events = activeSchema.events;
export const automationRules = activeSchema.automationRules;
export const automationRuns = activeSchema.automationRuns;
export const reviewConfigs = activeSchema.reviewConfigs;
export const reviews = activeSchema.reviews;
export const usageEvents = activeSchema.usageEvents;
export const businessReports = activeSchema.businessReports;
export const platformSettings = activeSchema.platformSettings;

// --- constants (identical in both modules) ---------------------------------
export const USER_ROLES = activeSchema.USER_ROLES;
export const LEAD_STATUSES = activeSchema.LEAD_STATUSES;
export const OPT_OUT_CHANNELS = activeSchema.OPT_OUT_CHANNELS;
export const LEAD_SCORES = activeSchema.LEAD_SCORES;
export const LEAD_CLASSIFICATIONS = activeSchema.LEAD_CLASSIFICATIONS;
export const HUMAN_TASK_PRIORITIES = activeSchema.HUMAN_TASK_PRIORITIES;
export const HUMAN_TASK_STATUSES = activeSchema.HUMAN_TASK_STATUSES;
export const APP_TYPES = activeSchema.APP_TYPES;
export const CONVERSATION_STATUSES = activeSchema.CONVERSATION_STATUSES;
export const MESSAGE_SENDERS = activeSchema.MESSAGE_SENDERS;
export const APPOINTMENT_STATUSES = activeSchema.APPOINTMENT_STATUSES;
export const FOLLOWUP_TYPES = activeSchema.FOLLOWUP_TYPES;
export const FOLLOWUP_STATUSES = activeSchema.FOLLOWUP_STATUSES;
export const PLAN_NAMES = activeSchema.PLAN_NAMES;
export const SUBSCRIPTION_STATUSES = activeSchema.SUBSCRIPTION_STATUSES;
export const INVOICE_STATUSES = activeSchema.INVOICE_STATUSES;
export const INTEGRATION_PROVIDERS = activeSchema.INTEGRATION_PROVIDERS;
export const INTEGRATION_STATUSES = activeSchema.INTEGRATION_STATUSES;
export const KB_KINDS = activeSchema.KB_KINDS;
export const WIDGET_POSITIONS = activeSchema.WIDGET_POSITIONS;
export const EVENTS = activeSchema.EVENTS;
export const AUTOMATION_RUN_STATUSES = activeSchema.AUTOMATION_RUN_STATUSES;
export const REVIEW_SENTIMENTS = activeSchema.REVIEW_SENTIMENTS;
export const USAGE_KINDS = activeSchema.USAGE_KINDS;
export const USAGE_DIRECTIONS = activeSchema.USAGE_DIRECTIONS;

// --- types (identical in both modules) -------------------------------------
export type UserRole = (typeof USER_ROLES)[number];
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type OptOutChannel = (typeof OPT_OUT_CHANNELS)[number] | "";
export type LeadScore = (typeof LEAD_SCORES)[number];
export type LeadClassification = (typeof LEAD_CLASSIFICATIONS)[number];
export type HumanTaskPriority = (typeof HUMAN_TASK_PRIORITIES)[number];
export type HumanTaskStatus = (typeof HUMAN_TASK_STATUSES)[number];
export type BusinessCategory = (typeof APP_TYPES)[number];
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];
export type EventType = (typeof EVENTS)[number];
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];
export type ReviewSentiment = (typeof REVIEW_SENTIMENTS)[number];
export type UsageKind = (typeof USAGE_KINDS)[number];
export type UsageDirection = (typeof USAGE_DIRECTIONS)[number];
