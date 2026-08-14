/**
 * Weekly business-intelligence report routes (spec §22) — AI BRAIN 4.
 *
 *   GET  /api/reports          list stored weekly reports (newest first)
 *   GET  /api/reports/:id      one stored report
 *   POST /api/reports/generate manual trigger { week_start?: number } — default
 *                              is the previous week; regenerating a week is
 *                              idempotent (replaces the stored report)
 *
 * Daily ops report routes (dogfooding #9 / Chunk G) — same shape, scoped to
 * business_reports rows with type='daily':
 *
 *   GET  /api/reports/daily            list stored daily reports (newest first,
 *                                      ?limit= defaults 12)
 *   GET  /api/reports/daily/:id        one stored daily report
 *   POST /api/reports/daily/generate   manual trigger { day_start?: number } —
 *                                      default is the previous (completed) day;
 *                                      regenerating a day is idempotent
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
import { generateDailyOpsReport, DAY_MS, dayStartFor } from "../bi/outreach";

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

function parseDailyReport(row: NonNullable<Awaited<ReturnType<typeof repo.getDailyReport>>>) {
  let metrics: unknown = {};
  let narrative: unknown = {};
  try {
    metrics = JSON.parse(row.metricsJson ?? "{}");
  } catch { /* keep {} */ }
  try {
    narrative = JSON.parse(row.narrativeJson ?? "{}");
  } catch { /* keep {} */ }
  return { id: row.id, businessId: row.businessId, dayStart: row.weekStart, dayEnd: row.weekStart + DAY_MS, metrics, narrative, createdAt: row.createdAt };
}

reportRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const rows = await repo.listWeeklyReports(business.id, 12);
  return c.json({ reports: rows.map(parseReport) });
});

// --- daily ops report (dogfooding #9 / Chunk G) — registered before "/:id"
// so the static "/daily" segment wins over the weekly get-by-id route. ------

reportRoutes.get("/daily", async (c) => {
  const business = await resolveBusiness(c);
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 90) : 12;
  const rows = await repo.listDailyReports(business.id, limit);
  return c.json({ reports: rows.map(parseDailyReport) });
});

reportRoutes.get("/daily/:id", async (c) => {
  const business = await resolveBusiness(c);
  const row = await repo.getDailyReportById(business.id, c.req.param("id"));
  if (!row || row.type !== repo.DAILY_REPORT_TYPE) throw new HttpError(404, "Report not found");
  return c.json({ report: parseDailyReport(row) });
});

const dailyGenerateSchema = z.object({
  day_start: z.number().int().optional(),
});

reportRoutes.post("/daily/generate", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = dailyGenerateSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  // Default: the previous (completed) day. Manual triggers may force any day.
  const dayStart = parsed.data.day_start ?? dayStartFor(Date.now() - DAY_MS);
  const report = await generateDailyOpsReport(business.id, dayStart);
  return c.json({ report }, 200);
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
