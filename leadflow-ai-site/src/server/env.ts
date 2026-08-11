/**
 * Central env access. Every environment variable the server reads goes through
 * this module so the swap-to-production story stays explicit and grep-able.
 */
export const env = {
  /** Set to a postgres:// URL to run on Postgres instead of the default SQLite file. */
  get databaseUrl() {
    return process.env.DATABASE_URL || "";
  },
  /** SQLite file path (relative to the site root, or absolute). */
  get databasePath() {
    return process.env.DATABASE_PATH || ".data/leadflow.db";
  },
  /** Cookie-signing / session secret. Falls back to a persisted file in .data/. */
  get sessionSecret() {
    return process.env.SESSION_SECRET || "";
  },
  /** Secret guarding /api/internal/tick (serverless cron). Empty = endpoint locked. */
  get internalToken() {
    return process.env.INTERNAL_TOKEN || "";
  },
  get aiProvider() {
    return process.env.AI_PROVIDER || "mock";
  },
  get smsProvider() {
    return process.env.SMS_PROVIDER || "mock";
  },
  get emailProvider() {
    return process.env.EMAIL_PROVIDER || "mock";
  },
  get calendarProvider() {
    return process.env.CALENDAR_PROVIDER || "mock";
  },
  get crmProvider() {
    return process.env.CRM_PROVIDER || "mock";
  },
  get stripeProvider() {
    return process.env.STRIPE_PROVIDER || "mock";
  },
  /** Provider API keys (health checks §40: a real provider without its key is
   *  ACTION REQUIRED; the mock provider is always HEALTHY). */
  get aiApiKey() {
    return process.env.AI_API_KEY || "";
  },
  get smsApiKey() {
    return process.env.SMS_API_KEY || process.env.TWILIO_API_KEY || "";
  },
  get emailApiKey() {
    return process.env.EMAIL_API_KEY || process.env.SENDGRID_API_KEY || "";
  },
  get calendarApiKey() {
    return process.env.CALENDAR_API_KEY || process.env.GOOGLE_CALENDAR_API_KEY || "";
  },
  get stripeApiKey() {
    return process.env.STRIPE_API_KEY || "";
  },
  /** True when the request arrived over TLS (the public proxy terminates TLS). */
  isHttpsRequest(forwardedProto?: string) {
    return forwardedProto === "https";
  },
};

export const SITE_ROOT = new URL("../..", import.meta.url).pathname; // /home/team/shared/site
