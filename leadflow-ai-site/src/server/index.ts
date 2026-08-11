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
import { env } from "./env";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function createApp() {
  runMigrations(); // idempotent; applies pending SQL migrations at boot

  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, app: "leadflow-ai", db: env.databaseUrl ? "postgres" : "sqlite", time: Date.now() }));

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
