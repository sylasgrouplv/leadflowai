/**
 * BUSINESS INTELLIGENCE AGENT (spec §22) — AI BRAIN 4.
 *
 * Weekly report generation from REAL data (deterministic aggregation; the
 * narrative is a mock-LLM text generated from the same numbers — no external
 * provider). Every number is computed from the business's own rows for the
 * week [week_start, week_start + 7d), Monday 00:00 UTC.
 *
 * Revenue figures use revenue attribution (spec §23): booked jobs × the
 * business's configured average job value per service — ALWAYS labeled
 * "Estimated Revenue", never presented as actuals.
 *
 * Scheduling: a weekly timer in the scheduler worker (src/server/jobs/
 * scheduler.ts) calls runWeeklyReportJob() on each tick — once a week has
 * fully ended (and a 1h settle window passed), the report for that week is
 * generated if missing. A manual trigger (POST /api/reports/generate) forces
 * generation for any week (tests + owner request). Reports persist in
 * business_reports and are listed on the Analytics page.
 */
import * as repo from "../db/repo";
import { isAgentEnabled } from "../platform/settings";
import { parseHours } from "../appointments/agent";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SETTLE_MS = 60 * 60 * 1000; // wait 1h after a week ends before auto-reporting

const QUALIFIED_STATUSES: string[] = ["qualified", "appointment_booked", "customer"];
const ACTIVE_APPT_STATUSES: string[] = ["booked", "confirmed", "completed"];

/** Monday 00:00 UTC of the week containing `ms`. */
export function weekStartFor(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 86_400_000;
}

export function weekEndFor(weekStart: number): number {
  return weekStart + WEEK_MS;
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

// ---------------------------------------------------------------------------
// After-hours detection (business hours in UTC — same convention as the
// calendar provider: parseHours + dayStartUTC)
// ---------------------------------------------------------------------------

function isAfterHours(hoursJson: string | null, ts: number): boolean {
  const hours = parseHours(hoursJson);
  const keys = Object.keys(hours);
  if (!keys.length) return false; // no hours configured → can't judge
  const d = new Date(ts);
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayKey = days[d.getUTCDay()];
  const day = hours[dayKey];
  if (!day || day.closed) return true;
  if (!day.open || !day.close) return true;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const [oh, om] = day.open.split(":").map(Number);
  const [ch, cm] = day.close.split(":").map(Number);
  const openMin = oh * 60 + om;
  const closeMin = ch * 60 + cm;
  if (openMin === closeMin) return true; // 00:00–00:00 = closed
  return minutes < openMin || minutes >= closeMin;
}

// ---------------------------------------------------------------------------
// Metrics + narrative
// ---------------------------------------------------------------------------

export interface WeeklyMetrics {
  weekStart: number;
  weekEnd: number;
  newLeads: number;
  qualified: number;
  appointmentsBooked: number;
  jobsCompleted: number;
  customers: number;
  leadToAppointmentRate: number;
  conversionRate: number;
  estimatedRevenueCents: number;
  aiMessages: number;
  aiConversations: number;
  afterHoursLeads: number;
  afterHoursAppointments: number;
  topServices: { service: string; count: number }[];
  leadSources: { source: string; count: number }[];
  avgResponseTimeMs: number;
  lostLeads: number;
  followupsSent: number;
  followupsDue: number;
  followupSendRate: number;
  feedbackRequests: number;
  positiveFeedback: number;
  negativeFeedback: number;
}

export interface WeeklyNarrative {
  summary: string;
  wins: string[];
  problems: string[];
  opportunities: string[];
  recommendedActions: string[];
}

function buildNarrative(m: WeeklyMetrics): WeeklyNarrative {
  const wins: string[] = [];
  const problems: string[] = [];
  const opportunities: string[] = [];
  const recommended: string[] = [];

  if (m.leadSources.length) {
    const top = m.leadSources[0];
    wins.push(`"${top.source}" was your strongest lead source this week with ${top.count} lead${top.count === 1 ? "" : "s"}.`);
  }
  if (m.afterHoursAppointments > 0) {
    wins.push(`You booked ${m.afterHoursAppointments} appointment${m.afterHoursAppointments === 1 ? "" : "s"} from ${m.afterHoursLeads} after-hours lead${m.afterHoursLeads === 1 ? "" : "s"} — your AI never missed a lead.`);
  }
  if (m.avgResponseTimeMs > 0 && m.avgResponseTimeMs < 10 * 60_000) {
    wins.push(`Your average AI response time was ${Math.max(1, Math.round(m.avgResponseTimeMs / 1000))}s.`);
  }
  if (m.positiveFeedback > 0) {
    wins.push(`${m.positiveFeedback} customer${m.positiveFeedback === 1 ? "" : "s"} left positive feedback.`);
  }
  if (m.newLeads > 0 && m.conversionRate >= 50) {
    wins.push(`Strong conversion: ${m.conversionRate}% of leads became customers.`);
  }

  if (m.lostLeads > 0) problems.push(`${m.lostLeads} lead${m.lostLeads === 1 ? "" : "s"} went cold without booking.`);
  if (m.negativeFeedback > 0) problems.push(`${m.negativeFeedback} customer${m.negativeFeedback === 1 ? "" : "s"} reported a negative experience — review the customer-service tasks.`);
  if (m.newLeads > 0 && m.leadToAppointmentRate < 30) problems.push(`Only ${m.leadToAppointmentRate}% of leads booked an appointment this week.`);
  if (m.newLeads === 0) problems.push("No new leads came in this week.");

  if (m.newLeads > 0) {
    const qualifiedNotBooked = m.qualified - m.appointmentsBooked;
    if (qualifiedNotBooked > 0) {
      opportunities.push(`${qualifiedNotBooked} qualified lead${qualifiedNotBooked === 1 ? "" : "s"} did not book — consider an extra follow-up.`);
      recommended.push(`Send an extra follow-up to the ${qualifiedNotBooked} qualified lead${qualifiedNotBooked === 1 ? "" : "s"} who did not book.`);
    }
  }
  if (m.afterHoursLeads > 0 && m.afterHoursAppointments === 0) {
    opportunities.push(`You received ${m.afterHoursLeads} lead${m.afterHoursLeads === 1 ? "" : "s"} after hours but booked none — follow up before the next business day.`);
    recommended.push("Follow up on after-hours leads first thing in the morning.");
  }
  if (m.leadSources.length > 1) {
    const weakest = m.leadSources[m.leadSources.length - 1];
    opportunities.push(`"${weakest.source}" converted only ${weakest.count} lead${weakest.count === 1 ? "" : "s"} — review that channel's quality.`);
  }
  if (m.followupsDue > 0 && m.followupSendRate < 100) {
    opportunities.push(`${m.followupsDue - m.followupsSent} follow-up${m.followupsDue - m.followupsSent === 1 ? "" : "s"} did not send this week.`);
    recommended.push("Check the follow-up log for blocked sends (missing phone/email, opt-outs).");
  }
  if (m.feedbackRequests === 0 && m.jobsCompleted > 0) {
    recommended.push("Turn on review requests for completed jobs to start collecting feedback.");
  }
  if (recommended.length === 0 && m.newLeads === 0) {
    recommended.push("Drive traffic to your website widget or add a lead source to start filling the pipeline.");
  }

  const summary = `${m.newLeads} new lead${m.newLeads === 1 ? "" : "s"}, ${m.qualified} qualified, ${m.appointmentsBooked} appointment${m.appointmentsBooked === 1 ? "" : "s"} booked, ${m.customers} customer${m.customers === 1 ? "" : "s"} (${m.conversionRate}% conversion). Estimated revenue from booked jobs: ${money(m.estimatedRevenueCents)}. The AI handled ${m.aiConversations} conversation${m.aiConversations === 1 ? "" : "s"} with ${m.aiMessages} message${m.aiMessages === 1 ? "" : "s"}.`;

  return { summary, wins, problems, opportunities, recommendedActions: recommended };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Aggregate the business's REAL rows for the week [weekStart, weekStart+7d).
 * Pure aggregation — no LLM, no sampling, no fabricated numbers.
 */
export async function computeWeeklyMetrics(businessId: string, weekStart: number): Promise<WeeklyMetrics> {
  const weekEnd = weekEndFor(weekStart);
  const business = await repo.getBusinessById(businessId);
  const hoursJson = business?.hoursJson ?? null;

  const [leads, appts, msgs, convs, fups, reviews, services] = await Promise.all([
    repo.listLeadsCreatedBetween(businessId, weekStart, weekEnd),
    repo.listAppointmentsCreatedBetween(businessId, weekStart, weekEnd),
    repo.listMessagesBetween(businessId, weekStart, weekEnd),
    repo.listConversationsBetween(businessId, weekStart, weekEnd),
    repo.listFollowUpsBetween(businessId, weekStart, weekEnd),
    repo.listReviewsBetween(businessId, weekStart, weekEnd),
    repo.listServices(businessId),
  ]);

  const newLeads = leads.length;
  const qualified = leads.filter((l) => QUALIFIED_STATUSES.includes(l.status)).length;
  const customers = leads.filter((l) => l.status === "customer").length;
  const lostLeads = leads.filter((l) => l.status === "lost").length;

  const activeAppts = appts.filter((a) => ACTIVE_APPT_STATUSES.includes(a.status));
  const appointmentsBooked = activeAppts.length;
  const jobsCompleted = appts.filter((a) => a.status === "completed").length;

  // Estimated revenue (§23): booked jobs in the week × configured avg value.
  const svcById = new Map(services.map((sv) => [sv.id, sv]));
  const estimatedRevenueCents = activeAppts.reduce((sum, a) => sum + (a.serviceId ? repo.effectiveServiceValue(svcById.get(a.serviceId) ?? null) : 0), 0);

  const aiMessages = msgs.filter((m) => m.sender === "ai").length;
  const convIds = new Set(convs.map((c) => c.id));
  const aiConversations = msgs.filter((m) => m.sender === "ai" && convIds.has(m.conversationId)).length ? convs.filter((c) => msgs.some((m) => m.conversationId === c.id)).length : 0;

  const afterHoursLeads = leads.filter((l) => isAfterHours(hoursJson, l.createdAt)).length;
  const afterHoursLeadIds = new Set(leads.filter((l) => isAfterHours(hoursJson, l.createdAt)).map((l) => l.id));
  const afterHoursAppointments = activeAppts.filter((a) => (a.leadId ? afterHoursLeadIds.has(a.leadId) : false)).length;

  // Top requested services + sources (week-scoped).
  const svcCounts = new Map<string, number>();
  for (const l of leads) {
    if (!l.serviceRequested) continue;
    svcCounts.set(l.serviceRequested, (svcCounts.get(l.serviceRequested) ?? 0) + 1);
  }
  const topServices = [...svcCounts.entries()]
    .map(([service, count]) => ({ service, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const srcCounts = new Map<string, number>();
  for (const l of leads) {
    const src = l.source && l.source.trim() ? l.source : "unknown";
    srcCounts.set(src, (srcCounts.get(src) ?? 0) + 1);
  }
  const leadSources = [...srcCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  // Average AI response time: first lead message → first AI message per
  // conversation, over the week's messages.
  const firstLeadByConv = new Map<string, number>();
  const firstAiByConv = new Map<string, number>();
  for (const m of msgs) {
    if (m.sender === "lead" && !firstLeadByConv.has(m.conversationId)) firstLeadByConv.set(m.conversationId, m.createdAt);
    if (m.sender === "ai" && !firstAiByConv.has(m.conversationId)) firstAiByConv.set(m.conversationId, m.createdAt);
  }
  const deltas: number[] = [];
  for (const [cid, leadAt] of firstLeadByConv) {
    const aiAt = firstAiByConv.get(cid);
    if (aiAt !== undefined && aiAt >= leadAt) deltas.push(aiAt - leadAt);
  }
  const avgResponseTimeMs = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;

  // Follow-up performance.
  const followupsDue = fups.filter((f) => f.status === "sent" || f.status === "pending").length;
  const followupsSent = fups.filter((f) => f.status === "sent").length;

  // Review feedback.
  const feedbackRequests = reviews.length;
  const positiveFeedback = reviews.filter((r) => r.sentiment === "positive").length;
  const negativeFeedback = reviews.filter((r) => r.sentiment === "negative").length;

  return {
    weekStart,
    weekEnd,
    newLeads,
    qualified,
    appointmentsBooked,
    jobsCompleted,
    customers,
    leadToAppointmentRate: pct(appointmentsBooked, newLeads),
    conversionRate: pct(customers, newLeads),
    estimatedRevenueCents,
    aiMessages,
    aiConversations,
    afterHoursLeads,
    afterHoursAppointments,
    topServices,
    leadSources,
    avgResponseTimeMs,
    lostLeads,
    followupsSent,
    followupsDue,
    followupSendRate: pct(followupsSent, followupsDue),
    feedbackRequests,
    positiveFeedback,
    negativeFeedback,
  };
}

/** Generate (and persist) the weekly report for a business+week. Idempotent. */
export async function generateWeeklyReport(businessId: string, weekStart: number) {
  const metrics = await computeWeeklyMetrics(businessId, weekStart);
  const narrative = buildNarrative(metrics);
  const row = await repo.upsertWeeklyReport(businessId, weekStart, metrics, narrative);
  await repo.logAgentAction(businessId, {
    agent: "bi",
    action: "weekly_report_generated",
    input: { weekStart, weekEnd: metrics.weekEnd },
    result: { reportId: row.id, newLeads: metrics.newLeads, estimatedRevenueCents: metrics.estimatedRevenueCents },
    success: true,
  });
  return { id: row.id, businessId, weekStart: metrics.weekStart, weekEnd: metrics.weekEnd, metrics, narrative, createdAt: row.createdAt };
}

/**
 * Weekly timer body (spec §22): for every business, generate the previous
 * week's report once it has fully ended (+ settle window) and no report exists
 * yet. Returns how many reports were created.
 */
export async function runWeeklyReportJob(nowMs = Date.now()): Promise<number> {
  // Spec §39 — the platform admin can disable the Business Intelligence agent.
  if (!(await isAgentEnabled("bi"))) return 0;
  const prevWeekStart = weekStartFor(nowMs - WEEK_MS);
  if (nowMs - weekEndFor(prevWeekStart) < SETTLE_MS) return 0; // week hasn't settled
  const ids = await repo.listAllBusinessIds();
  let made = 0;
  for (const businessId of ids) {
    const existing = await repo.getWeeklyReport(businessId, prevWeekStart);
    if (existing) continue;
    try {
      await generateWeeklyReport(businessId, prevWeekStart);
      made += 1;
    } catch (e) {
      console.error(`[bi] weekly report failed for ${businessId}:`, e);
    }
  }
  return made;
}
