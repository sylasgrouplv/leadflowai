/**
 * AI BRAIN 4 — REVIEW AGENT + BUSINESS INTELLIGENCE + REVENUE ATTRIBUTION
 * acceptance test (spec §21 review agent, §22 weekly report, §23 revenue
 * attribution). Runs IN-PROCESS against the local SQLite DB (same pattern as
 * auto-test.ts / tools-test.ts — the server and this process share
 * .data/leadflow.db).
 *
 * Proves (Definition of Done):
 *   (a) JOB_COMPLETED → review flow scheduled (default rule) → feedback
 *       request sent through the engine (audited + REVIEW_REQUESTED event) →
 *       positive feedback → review link sent with the configured review_url,
 *   (b) negative feedback → customer-service human task created and NO public
 *       review link is ever sent,
 *   (c) weekly report generation: correct aggregates from REAL rows (numbers
 *       verified by hand) incl. estimated revenue + opportunities; reports
 *       persist and list; tenant isolation (another business sees nothing),
 *   (d) revenue attribution: configured average job value drives estimated
 *       revenue; 0 falls back to list price.
 *
 * Run:  cd /home/team/shared/site && bun run brain4-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { callAiTool } from "./src/server/ai/tools/registry";
import { listEvents } from "./src/server/ai/events";
import { runAutomationEngine } from "./src/server/automations/engine";
import { ensureDefaultRulesForBusiness } from "./src/server/automations/rules";
import * as apptAgent from "./src/server/appointments/agent";
// Normalizing wrappers: the appointment agent APIs are camelCase
// ({ leadId, startAt, serviceId } / { appointmentId, status }); accept the
// snake_case keys used elsewhere for readability.
const bookAppointmentAction = async (bizId: string, input: any): Promise<any> =>
  apptAgent.bookAppointmentAction(bizId, {
    leadId: input.lead_id ?? input.leadId,
    serviceId: input.service_id ?? input.serviceId,
    startAt: input.start_at ?? input.startAt,
    notes: input.notes,
  });
const updateAppointmentStatusAction = async (bizId: string, input: any): Promise<any> =>
  apptAgent.updateAppointmentStatusAction(bizId, {
    appointmentId: input.appointment_id ?? input.appointmentId,
    status: input.status,
  });
import { generateWeeklyReport, computeWeeklyMetrics, weekStartFor, WEEK_MS } from "./src/server/bi/report";
import { classifySentiment } from "./src/server/reviews/agent";
import { getDb } from "./src/server/db/client";
import * as schema from "./src/server/db/schema";
import { eq } from "drizzle-orm";
runMigrations();
const SOURCE = "brain4_test";
const START_TS = Date.now();
const CTX = { businessId: "", agent: "brain4-test" };
let failures = 0;
const createdLeadIds: string[] = [];
const createdServiceIds: string[] = [];
const createdRuleIds: string[] = [];
let createdReportId: string | null = null;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
// ---------------------------------------------------------------------------
// Setup: demo business (same seed as the other suites)
// ---------------------------------------------------------------------------
const owner = await repo.getUserByEmail("demo@leadflow.ai");
if (!owner) {
  console.error("SKIP: demo user missing — run `bun run db:seed` first");
  process.exit(1);
}
const business = await repo.getBusinessForUser(owner.id);
if (!business) {
  console.error("SKIP: demo business missing — run `bun run db:seed` first");
  process.exit(1);
}
CTX.businessId = business.id;
const bizId = business.id;
// Snapshot pre-test state so cleanup can restore it exactly: default rules
// this run adds (e.g. job_completed_review) and the review config it overwrites.
const preRuleIds = new Set((await repo.listAutomationRules(bizId)).map((r) => r.id));
await ensureDefaultRulesForBusiness(bizId);
for (const r of await repo.listAutomationRules(bizId)) if (!preRuleIds.has(r.id)) createdRuleIds.push(r.id);
const preReviewConfig = await repo.getReviewConfig(bizId);
const rules = await repo.listAutomationRules(bizId);
pass("default review rule wired (job_completed_review)", rules.some((r) => r.name === "job_completed_review" && r.action === "send_review_request"));

async function newLead(over: { firstName?: string; phone?: string; serviceRequested?: string; source?: string } = {}) {
  const lead = (await callAiTool("create_lead", CTX, {
    first_name: over.firstName ?? "Brain4",
    last_name: "Test",
    phone: over.phone ?? "+15550001000",
    email: "",
    source: over.source ?? "website",
    service_requested: over.serviceRequested ?? "",
    location: "Springfield",
  })) as Awaited<ReturnType<typeof repo.createLead>>;
  if (!lead) throw new Error("could not create lead");
  createdLeadIds.push(lead.id);
  return lead;
}
/**
 * Pick a week (walking backwards) that provably has no leads or appointments
 * for this business, so the report block's exact aggregates can never be
 * polluted by seed data or other suites' rows.
 */
async function pickEmptyWeek(): Promise<number> {
  let ws = weekStartFor(Date.now()) - 3 * WEEK_MS;
  for (let i = 0; i < 8; i++) {
    const leads = await repo.listLeadsCreatedBetween(bizId, ws, ws + WEEK_MS);
    const appts = await repo.listAppointmentsCreatedBetween(bizId, ws, ws + WEEK_MS);
    if (leads.length === 0 && appts.length === 0) return ws;
    ws -= WEEK_MS;
  }
  throw new Error("no empty week found for BI fixtures");
}
async function actionsFor(leadId: string) {
  const all = await repo.listAgentActions(bizId, 600);
  return all.filter((a) => a.leadId === leadId);
}
function resultOf(a: { resultJson: string | null }) {
  try { return JSON.parse(a.resultJson ?? "{}"); } catch { return {}; }
}
function inputOf(a: { inputJson: string | null }) {
  try { return JSON.parse(a.inputJson ?? "{}"); } catch { return {}; }
}
function payloadOf(r: { payloadJson: string | null }) {
  try { return JSON.parse(r.payloadJson ?? "{}"); } catch { return {}; }
}
/**
 * Fetch real future slots from the deterministic mock calendar (never invent
 * times — same pattern as auto-test.ts / verify-fresh.ts). The mock's 30-min
 * grid makes adjacent slots overlap for 60-min services, so only slots that
 * don't overlap each other are returned (booking one must not make the next
 * "just taken").
 */
async function futureSlots(serviceId: string, count: number, days = 14): Promise<number[]> {
  const daysArr = await apptAgent.checkCalendarAction(bizId, { serviceId, days });
  const slots = daysArr
    .flatMap((d) => d.slots)
    .filter((s) => s.startAt > Date.now() + 60_000)
    .sort((a, b) => a.startAt - b.startAt);
  const picked: number[] = [];
  let lastEnd = 0;
  for (const s of slots) {
    if (picked.length >= count) break;
    if (s.startAt < lastEnd) continue; // would overlap a previously picked slot
    picked.push(s.startAt);
    lastEnd = s.endAt;
  }
  return picked;
}

/** Complete a booked appointment and let the engine materialize runs. */
async function completeJob(leadId: string, serviceId: string) {
  const starts = await futureSlots(serviceId, 1);
  if (!starts.length) throw new Error("no future slot available for booking");
  const booked = (await bookAppointmentAction(bizId, { lead_id: leadId, service_id: serviceId, start_at: starts[0] })) as {
    appointment: { id: string };
  };
  const apptId = booked?.appointment?.id;
  if (!apptId) throw new Error("booking failed");
  const updated = await updateAppointmentStatusAction(bizId, { appointment_id: apptId, status: "completed" });
  if (!updated) throw new Error("completing failed");
  await runAutomationEngine();
  return apptId;
}
/** Find the pending review-request run for an appointment and make it due. */
async function makeReviewRunDue(appointmentId: string) {
  const runs = await repo.listAutomationRuns(bizId, 800);
  const run = runs.find((r) => payloadOf(r).appointmentId === appointmentId || payloadOf(r).appointment_id === appointmentId);
  if (!run) throw new Error("no review run materialized for " + appointmentId);
  await repo.updateAutomationRun(bizId, run.id, { runAt: Date.now() - 5_000 });
  await runAutomationEngine();
  return run;
}

console.log("\n== (a) review flow: completed job → feedback → positive → review link ==");
{
  await repo.saveReviewConfig(bizId, { enabled: true, delayDays: 1, reviewUrl: "https://maps.example.com/reviews/brain4" });
  const services = await repo.listServices(bizId);
  const svc = services[0]!;
  const lead = await newLead({ firstName: "Positive", phone: "+15550001111", serviceRequested: svc.name });
  const apptId = await completeJob(lead.id, svc.id);
  const run = await makeReviewRunDue(apptId);
  const review = await repo.getReviewForAppointment(bizId, apptId);
  pass("review row created with request timestamp", !!review?.reviewRequestSentAt, `sentAt=${review?.reviewRequestSentAt ?? "null"}`);
  const acts = await actionsFor(lead.id);
  pass("feedback request audited (review_requested + sms send)", acts.some((a) => a.action === "review_requested"), "");
  const sms = acts.find((a) => a.action === "send_sms");
  pass("request body asks for feedback, never pressures", sms ? /feedback|how your experience/i.test(String(inputOf(sms).body ?? "")) : false, String(inputOf(sms ?? { inputJson: "{}" }).body ?? "").slice(0, 90));
  pass("REVIEW_REQUESTED event emitted", (await listEvents(bizId, 800)).some((e) => e.type === "REVIEW_REQUESTED" && e.leadId === lead.id), "");
  const dueRun = await repo.getAutomationRunById(bizId, run.id);
  pass("engine run finished (done)", dueRun?.status === "done", `status=${dueRun?.status}`);

  // Customer replies positively (the reply channel — registry tool, as the
  // chat endpoint does).
  const fb = (await callAiTool("record_feedback", CTX, { review_id: review!.id, feedback_text: "Great job, fast and professional! Highly recommend." })) as { sentiment: string; reviewLinkSent: boolean };
  pass("positive sentiment classified", fb.sentiment === "positive", `got ${fb.sentiment}`);
  pass("review link sent (reviewLinkSentAt set)", fb.reviewLinkSent === true && (await repo.getReviewById(bizId, review!.id))?.reviewLinkSentAt != null, "");
  const postActs = await actionsFor(lead.id);
  const linkSms = postActs.filter((a) => a.action === "send_sms" && String(inputOf(a).body ?? "").includes("https://maps.example.com/reviews/brain4"));
  pass("review link uses the configured review_url", linkSms.length > 0, "");
}

console.log("\n== (b) negative feedback → human task, NO review link ==");
{
  const services = await repo.listServices(bizId);
  const svc = services[0]!;
  const lead = await newLead({ firstName: "Negative", phone: "+15550002222", serviceRequested: svc.name });
  const apptId = await completeJob(lead.id, svc.id);
  await makeReviewRunDue(apptId);
  const review = await repo.getReviewForAppointment(bizId, apptId);
  const before = await repo.listHumanTasks(bizId, 200);
  const fb = (await callAiTool("record_feedback", CTX, { review_id: review!.id, feedback_text: "Awful experience, unprofessional and late. Very disappointed." })) as { sentiment: string; reviewLinkSent: boolean; humanTaskCreated: boolean };
  pass("negative sentiment classified", fb.sentiment === "negative", `got ${fb.sentiment}`);
  pass("NO review link sent", fb.reviewLinkSent === false && (await repo.getReviewById(bizId, review!.id))?.reviewLinkSentAt == null, "");
  const after = await repo.listHumanTasks(bizId, 200);
  const mine = after.filter((t) => !before.some((b) => b.id === t.id) && t.leadId === lead.id);
  pass("customer-service human task created for the lead", fb.humanTaskCreated === true && mine.length > 0, `tasks=${mine.length}`);
  const acts = await actionsFor(lead.id);
  pass("no review URL was ever sent for this lead", !acts.some((a) => a.action === "send_sms" && String(inputOf(a).body ?? "").includes("maps.example.com")), "");
}

console.log("\n== (d) revenue attribution: configured avg value vs list price ==");
{
  const svcA = await repo.addService(bizId, { name: "Brain4 Svc A", priceCents: 10_000, durationMin: 60 }); // 0 avg → list price
  const svcB = await repo.addService(bizId, { name: "Brain4 Svc B", priceCents: 20_000, durationMin: 60, averageValueCents: 22_800 }); // custom avg
  createdServiceIds.push(svcA.id, svcB.id);
  pass("default avg value = list price", repo.effectiveServiceValue(svcA) === 10_000, `got ${repo.effectiveServiceValue(svcA)}`);
  pass("custom avg value used when configured", repo.effectiveServiceValue(svcB) === 22_800, `got ${repo.effectiveServiceValue(svcB)}`);
}

console.log("\n== (c) weekly report: correct aggregates from real data ==");
{
  // Fixtures: 3 qualified leads, 2 bookings (1 completed). All rows are placed
  // in a provably-empty synthetic week (leads + appointments backdated) so the
  // exact aggregates below hold regardless of seed data or other suites' rows
  // in the current week. Metrics count by row created_at, not start time.
  const weekStart = await pickEmptyWeek();
  const svcA = await repo.addService(bizId, { name: "BI Svc A", priceCents: 10_000, durationMin: 60 });
  const svcB = await repo.addService(bizId, { name: "BI Svc B", priceCents: 20_000, durationMin: 60 });
  createdServiceIds.push(svcA.id, svcB.id);
  const mkBiLead = (firstName: string, phone: string, serviceRequested: string, at: number) =>
    repo.createLead({ businessId: bizId, firstName, lastName: "Test", phone, email: "", source: "website", serviceRequested, location: "Springfield", createdAt: at });
  const l1 = await mkBiLead("BI1", "+15550003331", "AC Tune-Up", weekStart + 1 * 3600_000);
  const l2 = await mkBiLead("BI2", "+15550003332", "AC Tune-Up", weekStart + 2 * 3600_000);
  const l3 = await mkBiLead("BI3", "+15550003333", "Roofing", weekStart + 3 * 3600_000);
  for (const l of [l1, l2, l3]) createdLeadIds.push(l!.id);
  for (const l of [l1!, l2!, l3!]) await callAiTool("set_lead_status", CTX, { lead_id: l.id, status: "qualified" });
  const [start1, start2] = await futureSlots(svcA.id, 2, 14);
  if (!start1 || !start2) throw new Error("no future slots available for BI bookings");
  const a1 = (await bookAppointmentAction(bizId, { lead_id: l1!.id, service_id: svcA.id, start_at: start1 })) as { appointment: { id: string } };
  const a2 = (await bookAppointmentAction(bizId, { lead_id: l2!.id, service_id: svcB.id, start_at: start2 })) as { appointment: { id: string } };
  await updateAppointmentStatusAction(bizId, { appointment_id: a2.appointment.id, status: "completed" });
  // Backdate the appointment rows into the fixture week (metrics count by
  // appointment.created_at — see listAppointmentsCreatedBetween).
  const db = getDb();
  db.update(schema.appointments).set({ createdAt: weekStart + 4 * 3600_000 }).where(eq(schema.appointments.id, a1.appointment.id)).run();
  db.update(schema.appointments).set({ createdAt: weekStart + 5 * 3600_000 }).where(eq(schema.appointments.id, a2.appointment.id)).run();

  const report = await generateWeeklyReport(bizId, weekStart);
  const m = report.metrics;
  // Hand-verified: 3 leads created, 3 qualified, 2 active appointments,
  // 1 completed; est revenue = 10_000 (list) + 20_000 (list) = 30_000.
  pass("newLeads = 3", m.newLeads === 3, `got ${m.newLeads}`);
  pass("qualified = 3", m.qualified === 3, `got ${m.qualified}`);
  pass("appointmentsBooked = 2", m.appointmentsBooked === 2, `got ${m.appointmentsBooked}`);
  pass("jobsCompleted = 1", m.jobsCompleted === 1, `got ${m.jobsCompleted}`);
  pass("lead→appointment rate = 66.7%", m.leadToAppointmentRate === 66.7, `got ${m.leadToAppointmentRate}`);
  pass("estimated revenue = $300 (30,000¢)", m.estimatedRevenueCents === 30_000, `got ${m.estimatedRevenueCents}`);
  pass("top services ranked", m.topServices[0]?.service === "AC Tune-Up" && m.topServices[0]?.count === 2, JSON.stringify(m.topServices));
  pass("lead sources aggregated", m.leadSources.some((s) => s.source === "website" && s.count >= 3), JSON.stringify(m.leadSources));
  pass("opportunity: qualified-not-booked follow-up", report.narrative.opportunities.some((o) => /did not book/.test(o)), JSON.stringify(report.narrative.opportunities));
  pass("recommended action for the lost booking", report.narrative.recommendedActions.some((a) => /extra follow-up/.test(a)), JSON.stringify(report.narrative.recommendedActions));
  pass("summary labels revenue as estimate", /Estimated revenue/.test(report.narrative.summary), "");
  // Persistence + listing.
  const stored = await repo.getWeeklyReport(bizId, weekStart);
  pass("report persisted", !!stored && (stored.metricsJson ?? "").includes("estimatedRevenueCents"), "");
  const listed = await repo.listWeeklyReports(bizId, 12);
  pass("report lists via endpoint data (repo)", listed.some((r) => r.id === report.id), "");
  // Tenant isolation.
  const otherReports = await repo.listWeeklyReports("00000000-0000-0000-0000-000000000000", 12);
  pass("tenant isolation: other business sees no reports", otherReports.length === 0, `got ${otherReports.length}`);
  // Manual recomputation equals the stored metrics (deterministic).
  const recomputed = await computeWeeklyMetrics(bizId, weekStart);
  pass("recompute is deterministic (matches stored)", recomputed.estimatedRevenueCents === m.estimatedRevenueCents && recomputed.newLeads === m.newLeads, "");
  createdReportId = report.id;
}

console.log("\n== sentiment classification unit checks ==");
pass("classify: positive", classifySentiment("great service, very happy") === "positive", "");
pass("classify: negative", classifySentiment("terrible, disappointed, rude") === "negative", "");
pass("classify: unknown stays neutral", classifySentiment("ok i guess") === "unknown", "");

// ---------------------------------------------------------------------------
// Cleanup: remove every row this run created (and leftovers from earlier
// crashed brain4 runs) while keeping Smith's HVAC seed set intact. brain4's
// test leads are identifiable by phone prefix +1555000 or test first names.
// ---------------------------------------------------------------------------
console.log("\n== cleanup ==");
try {
  const db = getDb();
  const leads = db
    .select()
    .from(schema.leads)
    .where(eq(schema.leads.businessId, bizId))
    .all()
    .filter(
      (l) =>
        createdLeadIds.includes(l.id) ||
        (l.phone ?? "").startsWith("+1555000") ||
        ["Positive", "Negative", "BI1", "BI2", "BI3"].includes(l.firstName)
    );
  for (const l of leads) {
    for (const c of db.select().from(schema.conversations).where(eq(schema.conversations.leadId, l.id)).all()) {
      db.delete(schema.messages).where(eq(schema.messages.conversationId, c.id)).run();
      db.delete(schema.conversations).where(eq(schema.conversations.id, c.id)).run();
    }
    db.delete(schema.events).where(eq(schema.events.leadId, l.id)).run();
    db.delete(schema.automationRuns).where(eq(schema.automationRuns.leadId, l.id)).run();
    db.delete(schema.followUps).where(eq(schema.followUps.leadId, l.id)).run();
    db.delete(schema.reviews).where(eq(schema.reviews.leadId, l.id)).run();
    db.delete(schema.appointments).where(eq(schema.appointments.leadId, l.id)).run();
    db.delete(schema.humanTasks).where(eq(schema.humanTasks.leadId, l.id)).run();
    db.delete(schema.agentActions).where(eq(schema.agentActions.leadId, l.id)).run();
    db.delete(schema.leads).where(eq(schema.leads.id, l.id)).run();
  }
  for (const sid of createdServiceIds) {
    db.delete(schema.services).where(eq(schema.services.id, sid)).run();
  }
  // Also sweep test services left behind by crashed runs of this suite (the
  // id list above only covers the current run; names are test-unique).
  for (const svc of db.select().from(schema.services).where(eq(schema.services.businessId, bizId)).all()) {
    if (/^(Brain4|BI) Svc [AB]$/.test(svc.name)) db.delete(schema.services).where(eq(schema.services.id, svc.id)).run();
  }
  for (const rid of createdRuleIds) {
    db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rid)).run();
    db.delete(schema.automationRules).where(eq(schema.automationRules.id, rid)).run();
  }
  if (createdReportId) {
    db.delete(schema.businessReports).where(eq(schema.businessReports.id, createdReportId)).run();
  }
  // Restore the review config: drop the row entirely when it only ever existed
  // because of this suite (defaults), otherwise put back the pre-test values.
  if (preReviewConfig.id === "" || preReviewConfig.reviewUrl.includes("maps.example.com/reviews/brain4")) {
    db.delete(schema.reviewConfigs).where(eq(schema.reviewConfigs.businessId, bizId)).run();
  } else {
    await repo.saveReviewConfig(bizId, {
      enabled: preReviewConfig.enabled === 1,
      delayDays: preReviewConfig.delayDays,
      reviewUrl: preReviewConfig.reviewUrl,
    });
  }
  const notifs = db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.businessId, bizId))
    .all()
    .filter((n) => n.createdAt >= START_TS);
  for (const n of notifs) db.delete(schema.notifications).where(eq(schema.notifications.id, n.id)).run();
  console.log(`cleanup done (${leads.length} brain4 test leads removed)`);
} catch (e) {
  console.error("cleanup error:", e);
}
console.log(`\nbrain4-test: ${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
