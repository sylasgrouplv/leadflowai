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
  /** True when the request arrived over TLS (the public proxy terminates TLS). */
  isHttpsRequest(forwardedProto?: string) {
    return forwardedProto === "https";
  },
};

export const SITE_ROOT = new URL("../..", import.meta.url).pathname; // /home/team/shared/site
