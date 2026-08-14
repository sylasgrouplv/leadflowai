/**
 * PHASE 2 / CHUNK G acceptance — DAILY OPS REPORT (dogfooding automation #9).
 *
 * Exercises:
 *   T1  computeDailyOpsMetrics: every metric maps to real columns and the
 *       day-scoped numbers + totals-to-date are exact for a seeded campaign
 *       (prospect leads in various states: new / contacted via follow-up /
 *       replied via conversation message / demo booked / customer)
 *   T2  source isolation: non-prospect leads (source='website_chat') and their
 *       appointments/messages never count
 *   T3  tenant isolation: another business's prospect leads don't leak into
 *       this business's report (repo-level + route-level)
 *   T4  generateDailyOpsReport idempotency: regenerating a day replaces the
 *       stored report (same id, one row per business+day) — upsert pattern
 *   T5  runDailyOpsReportJob idempotent-create: mirrors runWeeklyReportJob
 *       (skip when the day already has a report; no duplicates)
 *   T6  type discriminator: daily rows live in business_reports with
 *       type='daily'; GET /api/reports (weekly list) never shows them and
 *       weekly get-by-id 404s on a daily id
 *   T7  routes: POST /api/reports/daily/generate + GET /api/reports/daily
 *       (list + ?limit + get-by-id) return the persisted metrics, auth-gated
 *       (401 unauthenticated)
 *
 * Style: matches brain6-test.ts — HTTP against the live server (port 3000,
 * run `bun run publish`/serve first) for the routes, in-process repo + DB
 * for the aggregation math (same SQLite DB as the server). Tenant-scoped
 * cleanup deletes every row this run created.
 *
 * Run:  cd /home/team/shared/site && unset DATABASE_URL && bun run daily-report-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { eq, and } from "drizzle-orm";
runMigrations();
const BASE = process.env.DAILY_REPORT_BASE ?? "http://localhost:3000";
const DAY = 24 * 60 * 60 * 1000;
// Fixed test day (UTC): 2026-08-04 — fully in the past, deterministic.
const DAY_START = Date.UTC(2026, 7, 4);
const T = (ms: number) => DAY_START + ms; // offset helper within the day
const EMAIL = `dailyreport_${Date.now()}@test.ai`;
let failures = 0;
let ownerId = "";
let bizA = "";
let bizB = "";
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();
import * as repo from "./src/server/db/repo";
import { computeDailyOpsMetrics, generateDailyOpsReport, runDailyOpsReportJob, dayStartFor } from "./src/server/bi/outreach";

/** Same tenant-scoped cleanup as support-test / onboarding-test (FK-safe). */
async function wipeBusiness(id: string) {
  for (const lead of await db.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.businessId, id)).execute()) {
    for (const a of await db.select().from(s.appointments).where(eq(s.appointments.leadId, lead.id)).execute()) await db.delete(s.appointments).where(eq(s.appointments.id, a.id)).execute();
    await db.delete(s.followUps).where(eq(s.followUps.leadId, lead.id)).execute();
    for (const c of await db.select().from(s.conversations).where(eq(s.conversations.leadId, lead.id)).execute()) {
      await db.delete(s.messages).where(eq(s.messages.conversationId, c.id)).execute();
      await db.delete(s.conversations).where(eq(s.conversations.id, c.id)).execute();
    }
    await db.delete(s.agentActions).where(eq(s.agentActions.leadId, lead.id)).execute();
    await db.delete(s.reviews).where(eq(s.reviews.leadId, lead.id)).execute();
    await db.delete(s.leads).where(eq(s.leads.id, lead.id)).execute();
  }
  await db.delete(s.humanTasks).where(eq(s.humanTasks.businessId, id)).execute();
  await db.delete(s.events).where(eq(s.events.businessId, id)).execute();
  await db.delete(s.automationRuns).where(eq(s.automationRuns.businessId, id)).execute();
  await db.delete(s.automationRules).where(eq(s.automationRules.businessId, id)).execute();
  await db.delete(s.reviewConfigs).where(eq(s.reviewConfigs.businessId, id)).execute();
  await db.delete(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, id)).execute();
  await db.delete(s.notifications).where(eq(s.notifications.businessId, id)).execute();
  await db.delete(s.usageEvents).where(eq(s.usageEvents.businessId, id)).execute();
  await db.delete(s.auditLogs).where(eq(s.auditLogs.businessId, id)).execute();
  await db.delete(s.widgetSettings).where(eq(s.widgetSettings.businessId, id)).execute();
  await db.delete(s.integrations).where(eq(s.integrations.businessId, id)).execute();
  await db.delete(s.subscriptions).where(eq(s.subscriptions.businessId, id)).execute();
  await db.delete(s.services).where(eq(s.services.businessId, id)).execute();
  await db.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, id)).execute();
  const members = await db.select({ userId: s.teamMembers.userId }).from(s.teamMembers).where(eq(s.teamMembers.businessId, id)).execute();
  await db.delete(s.teamMembers).where(eq(s.teamMembers.businessId, id)).execute();
  await db.delete(s.businesses).where(eq(s.businesses.id, id)).execute();
  for (const m of members) {
    await db.delete(s.sessions).where(eq(s.sessions.userId, m.userId)).execute();
    await db.delete(s.users).where(eq(s.users.id, m.userId)).execute();
  }
}

// ---------------------------------------------------------------------------
// In-process seeding — creates prospect data for a business directly in the
// shared SQLite DB (same file the HTTP server uses).
// ---------------------------------------------------------------------------
async function seedCampaign(bizId: string, stamp: string) {
  const mkProspect = (o: { firstName: string; createdAt: number; status?: string }) =>
    repo.createLead({ businessId: bizId, firstName: o.firstName, lastName: stamp, source: "prospect_import", createdAt: o.createdAt, status: (o.status as s.LeadStatus) ?? "new", phone: "(517) 555-0100", email: `${o.firstName}.${stamp}@example.com` });
  // L1: created in-day, follow-up sent in-day, never replied.
  const l1 = await mkProspect({ firstName: "L1", createdAt: T(1 * 60 * 60 * 1000) });
  // L2: created in-day, follow-up sent in-day, REPLIED in-day (lead message).
  const l2 = await mkProspect({ firstName: "L2", createdAt: T(2 * 60 * 60 * 1000), status: "qualified" });
  // L3: created before the day, follow-up sent in-day, replied before the day,
  //     demo appointment BOOKED in-day.
  const l3 = await mkProspect({ firstName: "L3", createdAt: DAY_START - 2 * DAY, status: "appointment_booked" });
  // L4: created in-day, contacted via chat in-day (lastContactedAt), no reply.
  const l4 = await mkProspect({ firstName: "L4", createdAt: T(4 * 60 * 60 * 1000) });
  await repo.updateLead(bizId, l4!.id, { lastContactedAt: T(5 * 60 * 60 * 1000) });
  // L5: created before the day, follow-up sent before the day, became a customer.
  const l5 = await mkProspect({ firstName: "L5", createdAt: DAY_START - 5 * DAY, status: "customer" });
  await repo.updateLead(bizId, l5!.id, { lastContactedAt: DAY_START - 4 * DAY });
  // Non-prospect lead (must never count): website_chat lead created in-day.
  await repo.createLead({ businessId: bizId, firstName: "Web", lastName: stamp, source: "website_chat", createdAt: T(6 * 60 * 60 * 1000), phone: "(517) 555-0200" });

  const ids = [l1!.id, l2!.id, l3!.id, l4!.id, l5!.id];
  // Follow-ups: L1/L2 sent in-day, L3 sent in-day, L5 sent before the day.
  const fu = (leadId: string, at: number, templateKey: string) =>
    db.insert(s.followUps).values({ id: `fu_${stamp}_${leadId}`, businessId: bizId, leadId, type: "email", scheduledFor: at, templateKey, status: "sent", attempts: 1, createdAt: at, updatedAt: at }).execute();
  await fu(l1!.id, T(90 * 60 * 1000), "sales_1");
  await fu(l2!.id, T(2 * 60 * 60 * 1000 + 30 * 60 * 1000), "sales_1");
  await fu(l3!.id, T(1 * 60 * 60 * 1000), "sales_2");
  await fu(l5!.id, DAY_START - 4 * DAY, "sales_1");
  // Conversations + replies: L2 replied in-day, L3 replied before the day.
  const conv2 = await repo.createConversation(bizId, { leadId: l2!.id, channel: "chat" });
  const conv3 = await repo.createConversation(bizId, { leadId: l3!.id, channel: "chat" });
  await repo.addMessage(bizId, { conversationId: conv2.id, sender: "lead", body: "Sounds good — let's talk.", createdAt: T(3 * 60 * 60 * 1000) });
  await repo.addMessage(bizId, { conversationId: conv3.id, sender: "lead", body: "Interested.", createdAt: DAY_START - DAY });
  // Appointments: L3 demo booked in-day (active); a website_chat lead's
  // appointment in-day (must NOT count); a cancelled prospect appt in-day.
  await repo.createAppointment({ businessId: bizId, leadId: l3!.id, startAt: T(26 * 60 * 60 * 1000), endAt: T(27 * 60 * 60 * 1000), status: "booked", createdAt: T(6 * 60 * 60 * 1000) });
  await repo.createAppointment({ businessId: bizId, leadId: l2!.id, startAt: T(28 * 60 * 60 * 1000), endAt: T(29 * 60 * 60 * 1000), status: "cancelled", createdAt: T(7 * 60 * 60 * 1000) });
  const web = await db.select().from(s.leads).where(and(eq(s.leads.businessId, bizId), eq(s.leads.source, "website_chat"))).execute();
  if (web[0]) await repo.createAppointment({ businessId: bizId, leadId: web[0].id, startAt: T(30 * 60 * 60 * 1000), endAt: T(31 * 60 * 60 * 1000), status: "booked", createdAt: T(8 * 60 * 60 * 1000) });
  return ids;
}

const cookies: Record<string, string> = {};
async function api(path: string, opts: { method?: string; body?: unknown; key?: string } = {}) {
  const key = opts.key ?? "a";
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(cookies[key] ? { cookie: cookies[key] } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc && key) cookies[key] = sc.split(";")[0];
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

(async () => {
  const stamp = `${Date.now()}`;
  // ================================================================ T0 SETUP
  // Two fresh owners + businesses (A = campaign under test, B = tenant isolation).
  let r = await api("/api/auth/signup", { method: "POST", body: { name: "Daily Report Owner A", email: EMAIL, password: "daily1234" } });
  ownerId = r.json.user?.id ?? "";
  pass("T0a signup owner A", r.status === 200 && !!ownerId, `status ${r.status}`);
  r = await api("/api/business", { method: "POST", body: { name: "Daily Report Co A", category: "home_services" } });
  bizA = r.json.business?.id ?? "";
  pass("T0b business A created", (r.status === 200 || r.status === 201) && !!bizA, `status ${r.status}`);
  r = await api("/api/auth/signup", { method: "POST", key: "b", body: { name: "Daily Report Owner B", email: `dailyb_${stamp}@test.ai`, password: "daily1234" } });
  const ownerB = r.json.user?.id ?? "";
  pass("T0c signup owner B", r.status === 200 && !!ownerB, `status ${r.status}`);
  r = await api("/api/business", { method: "POST", key: "b", body: { name: "Daily Report Co B", category: "home_services" } });
  bizB = r.json.business?.id ?? "";
  pass("T0d business B created", (r.status === 200 || r.status === 201) && !!bizB, `status ${r.status}`);

  // ================================================================ T1 MATH
  console.log("\n== aggregation ==");
  const leadIdsA = await seedCampaign(bizA, stamp);
  // Business B: one prospect lead created in the same day (isolation check).
  await repo.createLead({ businessId: bizB, firstName: "B1", lastName: stamp, source: "prospect_import", createdAt: T(2 * 60 * 60 * 1000), phone: "(517) 555-0300" });

  const m = await computeDailyOpsMetrics(bizA, DAY_START);
  pass("T1a leadsCreated (day)", m.leadsCreated === 3, `got ${m.leadsCreated}`);
  pass("T1b contacted (day)", m.contacted === 4, `got ${m.contacted}`);
  pass("T1c followupsSent (day)", m.followupsSent === 3, `got ${m.followupsSent}`);
  pass("T1d replies (day)", m.replies === 1, `got ${m.replies}`);
  pass("T1e demosBooked (day)", m.demosBooked === 1, `got ${m.demosBooked}`);
  pass("T1f totalLeads", m.totalLeads === 5, `got ${m.totalLeads}`);
  pass("T1g totalContacted", m.totalContacted === 5, `got ${m.totalContacted}`);
  pass("T1h totalReplied", m.totalReplied === 2, `got ${m.totalReplied}`);
  pass("T1i totalDemosBooked", m.totalDemosBooked === 1, `got ${m.totalDemosBooked}`);
  pass("T1j qualified", m.qualified === 3, `got ${m.qualified}`);
  pass("T1k customers", m.customers === 1, `got ${m.customers}`);
  pass("T1l closeRate", m.closeRate === 33.3, `got ${m.closeRate}`);
  pass("T1m replyRate", m.replyRate === 40, `got ${m.replyRate}`);
  pass("T1n dayStart/dayEnd window", m.dayStart === DAY_START && m.dayEnd === DAY_START + DAY, `dayStart ${m.dayStart} dayEnd ${m.dayEnd}`);
  pass("T1o source isolation (website_chat lead ignored)", m.leadsCreated === 3 && m.totalLeads === 5, "non-prospect lead never counted");
  pass("T1p cancelled prospect appointment not booked", m.demosBooked === 1 && m.totalDemosBooked === 1, "cancelled appt excluded");

  // ================================================================ T3 TENANT
  console.log("\n== tenant isolation ==");
  const mB = await computeDailyOpsMetrics(bizB, DAY_START);
  pass("T3a business B sees only its own leads", mB.totalLeads === 1 && mB.leadsCreated === 1, `got ${mB.totalLeads}`);
  pass("T3b business A unaffected by B", m.totalLeads === 5, `got ${m.totalLeads}`);

  // ================================================================ T5 JOB
  console.log("\n== scheduler job (idempotent-create) ==");
  const jobNow = DAY_START + DAY + 1; // job's "previous day" == DAY_START
  const made1 = await runDailyOpsReportJob(jobNow);
  const after1 = await repo.getDailyReport(bizA, DAY_START);
  pass("T5a job created the day's report", made1 >= 1 && !!after1, `made=${made1}`);
  const made2 = await runDailyOpsReportJob(jobNow);
  const after2 = await repo.getDailyReport(bizA, DAY_START);
  pass("T5b job skips existing day report (no duplicate)", after2 !== null && after1 !== null && after1.id === after2.id, `made2=${made2} sameId=${after1?.id === after2?.id}`);
  const rowsA = await db.select().from(s.businessReports).where(and(eq(s.businessReports.businessId, bizA), eq(s.businessReports.type, "daily"), eq(s.businessReports.weekStart, DAY_START))).execute();
  pass("T5c exactly one daily row per business+day", rowsA.length === 1, `n=${rowsA.length}`);

  // ================================================================ T4 IDEMPOTENT UPSERT
  console.log("\n== generate idempotency ==");
  const gen1 = await generateDailyOpsReport(bizA, DAY_START);
  const gen2 = await generateDailyOpsReport(bizA, DAY_START);
  pass("T4a regenerate returns same report id (upsert)", gen1.id === gen2.id, `${gen1.id} vs ${gen2.id}`);
  const rowsA2 = await db.select().from(s.businessReports).where(and(eq(s.businessReports.businessId, bizA), eq(s.businessReports.type, "daily"), eq(s.businessReports.weekStart, DAY_START))).execute();
  pass("T4b still one row after regenerate", rowsA2.length === 1, `n=${rowsA2.length}`);
  pass("T4c stored metrics match the computed numbers", (rowsA2[0]?.metricsJson ?? "").includes('"leadsCreated":3'), "");

  // ================================================================ T6 TYPE DISCRIMINATOR
  console.log("\n== type discriminator ==");
  const dailyList = await repo.listDailyReports(bizA);
  const weeklyList = await repo.listWeeklyReports(bizA);
  pass("T6a listDailyReports returns the daily row", dailyList.length >= 1 && dailyList[0].type === "daily", `n=${dailyList.length}`);
  pass("T6b listWeeklyReports excludes daily rows", weeklyList.every((w) => w.type === "weekly"), `n=${weeklyList.length}`);
  const weeklyLookup = await repo.getWeeklyReport(bizA, DAY_START);
  pass("T6c getWeeklyReport never returns a daily row", weeklyLookup === null, JSON.stringify(weeklyLookup));

  // ================================================================ T7 ROUTES
  console.log("\n== routes ==");
  // Unauthenticated → 401.
  const anon = await fetch(BASE + "/api/reports/daily", { headers: { "content-type": "application/json" } });
  pass("T7a GET /api/reports/daily unauthenticated → 401", anon.status === 401, `status ${anon.status}`);
  // Manual generate (idempotent upsert via the route).
  r = await api("/api/reports/daily/generate", { method: "POST", body: { day_start: DAY_START } });
  pass("T7b POST /api/reports/daily/generate", r.status === 200 && r.json.report?.metrics?.leadsCreated === 3 && r.json.report?.dayStart === DAY_START, `status ${r.status}`);
  const genId = r.json.report?.id ?? "";
  // List.
  r = await api("/api/reports/daily");
  const listed = (r.json.reports ?? []).find((x: { id: string }) => x.id === genId);
  pass("T7c GET /api/reports/daily lists the report", r.status === 200 && !!listed && listed.dayStart === DAY_START, `status ${r.status}`);
  // Get by id.
  r = await api(`/api/reports/daily/${genId}`);
  pass("T7d GET /api/reports/daily/:id", r.status === 200 && r.json.report?.metrics?.demosBooked === 1, `status ${r.status}`);
  // Weekly list + get-by-id never expose daily rows.
  r = await api("/api/reports");
  pass("T7e weekly list excludes the daily report", r.status === 200 && !(r.json.reports ?? []).some((x: { id: string }) => x.id === genId), `status ${r.status}`);
  r = await api(`/api/reports/${genId}`);
  pass("T7f weekly get-by-id on a daily id → 404", r.status === 404, `status ${r.status}`);
  // Tenant isolation at the route: B's list has B's report, not A's.
  r = await api("/api/reports/daily", { key: "b" });
  const bIds = (r.json.reports ?? []).map((x: { id: string }) => x.id);
  pass("T7g business B cannot see A's daily report", r.status === 200 && !bIds.includes(genId), `status ${r.status}`);
  // ?limit
  r = await api("/api/reports/daily?limit=5");
  pass("T7h ?limit honored", r.status === 200 && (r.json.reports ?? []).length <= 5, `n=${(r.json.reports ?? []).length}`);

  // ================================================================ CLEANUP
  await wipeBusiness(bizA);
  await wipeBusiness(bizB);
  // Remove any daily reports the job created for OTHER businesses on the test
  // day (the feature is new — only this run could have created them).
  await db.delete(s.businessReports).where(and(eq(s.businessReports.type, "daily"), eq(s.businessReports.weekStart, DAY_START))).execute();

  console.log("\n" + (failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("daily-report-test crashed:", e);
  process.exit(1);
});
