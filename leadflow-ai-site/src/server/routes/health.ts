/**
 * SYSTEM HEALTH DASHBOARD (spec §40) — no silent malfunction.
 *
 *   GET /api/health/system   owner | admin
 *
 * Live status per service: AI API, Database, Calendar, SMS, Email, CRM, Stripe,
 * Automation Queue — each CONNECTED/HEALTHY or ACTION REQUIRED.
 *
 * Provider checks reflect the PROVIDER INTERFACE status honestly:
 *   - mock provider  -> CONNECTED with a "mock" label (never claims a live
 *     connection that doesn't exist — the UI shows "Mock (simulated)")
 *   - real provider  -> CONNECTED only when the matching API key is present;
 *     missing credentials -> ACTION REQUIRED with the exact env var to set.
 * Database is checked with a live query; the Automation Queue reports failed /
 * stuck runs in the last 7 days (failures surface, never silent).
 */
import { Hono } from "hono";
import { attachUser, HttpError, requireUser } from "../auth/guards";
import { env } from "../env";
import { isPgMode, getDb, getPgClient } from "../db/client";
import * as s from "../db/schema";
import { count, gte } from "drizzle-orm";
import * as repo from "../db/repo";

export const healthRoutes = new Hono();
healthRoutes.use("*", attachUser);

export type ServiceStatus = "CONNECTED" | "ACTION REQUIRED";
export type ServiceStatusKind = "ok" | "mock" | "action";

export interface HealthService {
  id: string;
  label: string;
  status: ServiceStatus;
  /** ok | mock | action — lets the UI badge "mock" distinctly. */
  kind: ServiceStatusKind;
  provider: string;
  detail: string;
}

function providerCheck(id: string, label: string, provider: string, key: string): HealthService {
  const isMock = provider === "mock";
  if (isMock) {
    return {
      id,
      label,
      status: "CONNECTED",
      kind: "mock",
      provider,
      detail: "Mock provider (simulated) — no external connection. Swap the provider env var + API key to go live.",
    };
  }
  if (key) {
    return { id, label, status: "CONNECTED", kind: "ok", provider, detail: `${provider} provider configured with API key.` };
  }
  return {
    id,
    label,
    status: "ACTION REQUIRED",
    kind: "action",
    provider,
    detail: `${provider} provider selected but no API key configured — set the ${id === "ai" ? "AI_API_KEY" : id === "sms" ? "SMS_API_KEY" : id === "email" ? "EMAIL_API_KEY" : id === "calendar" ? "CALENDAR_API_KEY" : id === "crm" ? "HUBSPOT_API_KEY" : id === "stripe" ? "STRIPE_API_KEY" : "API_KEY"} environment variable.`,
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

healthRoutes.get("/system", async (c) => {
  // Owner or admin (admins may be business-less — no tenant required here).
  await requireUser(c);

  // 1) Database — real query every time.
  let dbStatus: HealthService;
  try {
    if (isPgMode()) {
      const pg = getPgClient();
      await pg`SELECT 1`;
    } else {
      await getDb().select({ n: count() }).from(s.businesses).limit(1).execute();
    }
    dbStatus = {
      id: "database",
      label: "Database",
      status: "CONNECTED",
      kind: "ok",
      provider: isPgMode() ? "postgres" : "sqlite",
      detail: `Live query OK (${isPgMode() ? "Postgres" : "SQLite"}${isPgMode() ? "" : " — local dev"})`,
    };
  } catch (e) {
    dbStatus = {
      id: "database",
      label: "Database",
      status: "ACTION REQUIRED",
      kind: "action",
      provider: isPgMode() ? "postgres" : "sqlite",
      detail: `Database query failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`,
    };
  }

  // 2) Provider interface status (mock-aware).
  const ai = providerCheck("ai", "AI API", env.aiProvider, env.aiApiKey);
  const calendar = providerCheck("calendar", "Calendar", env.calendarProvider, env.calendarApiKey);
  const sms = providerCheck("sms", "SMS", env.smsProvider, env.smsApiKey);
  const email = providerCheck("email", "Email", env.emailProvider, env.emailApiKey);
  const crm = providerCheck("crm", "CRM", env.crmProvider, env.hubspotApiKey);
  const stripe = providerCheck("stripe", "Stripe", env.stripeProvider, env.stripeApiKey);

  // 3) Automation queue — failed/stuck runs in the last 7 days.
  const since = Date.now() - WEEK_MS;
  let queue: HealthService;
  try {
    const failed = await repo.listFailedAutomationRuns(1000, since);
    const stuck = await repo.listStuckAutomationRuns();
    const pendingDue = (await repo.listDueAutomationRuns(1000)).length;
    const blocked = failed.filter((r) => /agent-disabled|disabled/i.test(r.lastError)).length;
    const healthyFailed = failed.length - blocked;
    if (healthyFailed > 0 || stuck.length > 0) {
      const parts: string[] = [];
      if (healthyFailed > 0) parts.push(`${healthyFailed} failed run${healthyFailed === 1 ? "" : "s"} in the last 7 days`);
      if (stuck.length > 0) parts.push(`${stuck.length} stuck run${stuck.length === 1 ? "" : "s"}`);
      queue = {
        id: "automation-queue",
        label: "Automation Queue",
        status: "ACTION REQUIRED",
        kind: "action",
        provider: "engine",
        detail: `${parts.join("; ")}${pendingDue > 0 ? ` · ${pendingDue} due run${pendingDue === 1 ? "" : "s"} waiting` : ""}. Check the Admin AI control page for details.`,
      };
    } else {
      queue = {
        id: "automation-queue",
        label: "Automation Queue",
        status: "CONNECTED",
        kind: "ok",
        provider: "engine",
        detail: `Engine healthy — no failed or stuck runs in the last 7 days${pendingDue > 0 ? `; ${pendingDue} due run${pendingDue === 1 ? "" : "s"} pending` : ""}.`,
      };
    }
  } catch (e) {
    queue = {
      id: "automation-queue",
      label: "Automation Queue",
      status: "ACTION REQUIRED",
      kind: "action",
      provider: "engine",
      detail: `Automation queue check failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`,
    };
  }

  const services: HealthService[] = [ai, dbStatus, calendar, sms, email, crm, stripe, queue];
  const anyAction = services.some((sv) => sv.status === "ACTION REQUIRED");
  return c.json({
    services,
    overall: anyAction ? "ACTION REQUIRED" : "CONNECTED",
    checkedAt: Date.now(),
    note: anyAction
      ? "One or more services need attention — resolve the items above. Nothing is hidden."
      : "All services connected. Mock providers are simulated — they work but are not live external connections.",
  });
});
