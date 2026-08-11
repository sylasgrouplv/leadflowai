/**
 * LeadFlow AI — Hono app factory.
 * Mounts all API routes, central error handling, and runs migrations lazily.
 */
import { Hono } from "hono";
import { authRoutes } from "./routes/auth";
import { businessRoutes } from "./routes/business";
import { serviceRoutes } from "./routes/services";
import { knowledgeRoutes } from "./routes/knowledge";
import { dashboardRoutes } from "./routes/dashboard";
import { integrationRoutes } from "./routes/integrations";
import { leadRoutes } from "./routes/leads";
import { chatRoutes } from "./routes/chat";
import { appointmentRoutes } from "./routes/appointments";
import { followUpRoutes } from "./routes/followups";
import { notificationRoutes } from "./routes/notifications";
import { widgetRoutes } from "./routes/widget";
import { aiRoutes } from "./routes/ai";
import { analyticsRoutes } from "./routes/analytics";
import { reviewRoutes } from "./routes/reviews";
import { reportRoutes } from "./routes/reports";
import { HttpError } from "./auth/guards";
import { runMigrations } from "./db/migrate";
import { runAutomationEngine } from "./automations/engine";
import { runWeeklyReportJob } from "./bi/report";
import { env } from "./env";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export async function createApp() {
  await runMigrations(); // idempotent; applies pending SQL migrations at boot

  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, app: "leadflow-ai", db: env.databaseUrl ? "postgres" : "sqlite", time: Date.now() }));

  /**
   * Internal one-pass worker tick — the serverless analogue of the always-on
   * scheduler in serve.ts (which runs runAutomationEngine + runWeeklyReportJob
   * on an interval). Serverless deployments have no background process, so
   * Vercel cron (vercel.json crons) or an external cron hits this endpoint.
   *
   * Guard: Vercel cron jobs cannot send custom headers, so the endpoint
   * accepts EITHER the internal token (header `x-internal-token`, used for
   * manual / external-cron calls) OR Vercel's cron signature header
   * (`x-vercel-cron`, set by Vercel's cron infrastructure). With no
   * INTERNAL_TOKEN set and no cron header, every request is rejected.
   */
  app.all("/api/internal/tick", async (c) => {
    const isVercelCron = c.req.header("x-vercel-cron") !== undefined;
    const tokenOk = env.internalToken !== "" && c.req.header("x-internal-token") === env.internalToken;
    if (!isVercelCron && !tokenOk) return c.json({ error: "Unauthorized" }, 401);
    if (c.req.method !== "GET" && c.req.method !== "POST") return c.json({ error: "Method not allowed" }, 405);
    const automation = await runAutomationEngine();
    const weeklyReports = await runWeeklyReportJob();
    return c.json({
      ok: true,
      automation: {
        checked: automation.checked,
        executed: automation.executed,
        done: automation.done,
        cancelled: automation.cancelled,
        failed: automation.failed,
        retried: automation.retried,
        backfilled: automation.backfilled,
        errors: automation.errors,
      },
      weeklyReports,
      time: Date.now(),
    });
  });

  app.route("/api/auth", authRoutes);
  app.route("/api/business", businessRoutes);
  app.route("/api/services", serviceRoutes);
  app.route("/api/knowledge", knowledgeRoutes);
  app.route("/api/dashboard", dashboardRoutes);
  app.route("/api/integrations", integrationRoutes);
  app.route("/api/leads", leadRoutes);
  app.route("/api/chat", chatRoutes);
  app.route("/api/appointments", appointmentRoutes);
  app.route("/api/follow-ups", followUpRoutes);
  app.route("/api/notifications", notificationRoutes);
  app.route("/api/widget", widgetRoutes);
  app.route("/api/ai", aiRoutes);
  app.route("/api/analytics", analyticsRoutes);
  app.route("/api/reviews", reviewRoutes);
  app.route("/api/reports", reportRoutes);

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as ContentfulStatusCode);
    }
    console.error("[api error]", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
