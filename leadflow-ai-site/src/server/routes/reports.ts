/**
 * Weekly business-intelligence report routes (spec §22) — AI BRAIN 4.
 *
 *   GET  /api/reports          list stored weekly reports (newest first)
 *   GET  /api/reports/:id      one stored report
 *   POST /api/reports/generate manual trigger { week_start?: number } — default
 *                              is the previous week; regenerating a week is
 *                              idempotent (replaces the stored report)
 *
 * Every report is generated from the business's REAL rows (deterministic
 * aggregation) with a mock-LLM narrative. Revenue figures are revenue
 * attribution estimates (§23) — the API marks them `estimated` and callers
 * must label them "Estimated Revenue", never actuals.
 */
import { Hono } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, resolveBusiness } from "../auth/guards";
import { generateWeeklyReport, weekStartFor, WEEK_MS } from "../bi/report";

export const reportRoutes = new Hono();
reportRoutes.use("*", attachUser);

function parseReport(row: NonNullable<Awaited<ReturnType<typeof repo.getWeeklyReport>>>) {
  let metrics: unknown = {};
  let narrative: unknown = {};
  try {
    metrics = JSON.parse(row.metricsJson ?? "{}");
  } catch { /* keep {} */ }
  try {
    narrative = JSON.parse(row.narrativeJson ?? "{}");
  } catch { /* keep {} */ }
  return { id: row.id, businessId: row.businessId, weekStart: row.weekStart, weekEnd: row.weekStart + WEEK_MS, metrics, narrative, createdAt: row.createdAt };
}

reportRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const rows = await repo.listWeeklyReports(business.id, 12);
  return c.json({ reports: rows.map(parseReport) });
});

reportRoutes.get("/:id", async (c) => {
  const business = await resolveBusiness(c);
  const row = await repo.getWeeklyReportById(business.id, c.req.param("id"));
  if (!row) throw new HttpError(404, "Report not found");
  return c.json({ report: parseReport(row) });
});

const generateSchema = z.object({
  week_start: z.number().int().optional(),
});

reportRoutes.post("/generate", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  // Default: the previous (completed) week. Manual triggers may force any week.
  const weekStart = parsed.data.week_start ?? weekStartFor(Date.now() - WEEK_MS);
  const report = await generateWeeklyReport(business.id, weekStart);
  return c.json({ report }, 200);
});
