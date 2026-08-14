/**
 * DAILY OPS REPORT (dogfooding #9 / Chunk G) — the sales-campaign view of the
 * BI agent, extending the weekly report (bi/report.ts) to a per-day cadence.
 *
 * Aggregates the business's prospect_import leads (Phase 1a CSV import,
 * source='prospect_import') + follow-ups + appointments by day, plus campaign
 * totals-to-date, so the LeadFlow AI tenant tracks its own outreach pipeline:
 * prospect leads → contacted → replied → demos booked → close rate. Any tenant
 * can use it for the same purpose (a business that imports prospects and runs
 * the sales follow-up cadence).
 *
 * METRIC → COLUMN MAP (every number is computed from REAL columns, no invented
 * fields; see computeDailyOpsMetrics):
 *   leadsCreated   -> leads.source='prospect_import' AND leads.createdAt in day
 *   contacted      -> distinct prospect leads with a follow_ups row
 *                     (status='sent' AND follow_ups.updatedAt in day — the send
 *                     transition timestamp, set by repo.updateFollowUp) OR
 *                     leads.lastContactedAt in day (chat contact, ai/engine.ts)
 *   replies        -> messages.sender='lead' AND messages.createdAt in day, in
 *                     a conversation whose conversations.leadId is a prospect
 *                     lead (proxy for "prospect replied" — the follow-up engine
 *                     has no replied column; any inbound prospect message is a
 *                     reply)
 *   followupsSent  -> follow_ups.status='sent' AND follow_ups.updatedAt in day
 *                     for prospect leads
 *   demosBooked    -> appointments for prospect leads with appointments.createdAt
 *                     in day AND status in (booked, confirmed, completed) — same
 *                     active-status rule as the weekly report
 *   totalLeads/qualified/customers -> current leads.status values
 *   totalContacted -> distinct prospect leads with ≥1 sent follow-up ever OR
 *                     leads.lastContactedAt set
 *   totalReplied   -> distinct prospect leads with ≥1 sender='lead' message
 *   totalDemosBooked -> active appointments for prospect leads (all time)
 *   closeRate      -> customers / qualified  (statuses qualified,
 *                     appointment_booked, customer — same QUALIFIED_STATUSES
 *                     as the weekly report)
 *
 * Deterministic aggregation + mock-LLM narrative (mirrors bi/report.ts — no
 * external provider, no fabricated numbers). Stored in business_reports with
 * type='daily' (week_start column holds the day start, midnight UTC) — the
 * (business_id, type, week_start) unique index makes one report per
 * business+day.
 *
 * Scheduling: the scheduler worker (jobs/scheduler.ts) calls
 * runDailyOpsReportJob() on each tick; once a day has fully ended, the report
 * for that day is generated if missing. A manual trigger
 * (POST /api/reports/daily/generate) forces generation for any day.
 */
import * as repo from "../db/repo";
import { isAgentEnabled } from "../platform/settings";
import { PROSPECT_IMPORT_SOURCE } from "../import/prospects";

export const DAY_MS = 24 * 60 * 60 * 1000;

const QUALIFIED_STATUSES: string[] = ["qualified", "appointment_booked", "customer"];
const ACTIVE_APPT_STATUSES: string[] = ["booked", "confirmed", "completed"];

/** Midnight UTC of the day containing `ms`. */
export function dayStartFor(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Metrics + narrative
// ---------------------------------------------------------------------------

export interface DailyOpsMetrics {
  dayStart: number;
  dayEnd: number;
  // Day-scoped (prospect_import leads only).
  leadsCreated: number;
  contacted: number;
  replies: number;
  followupsSent: number;
  demosBooked: number;
  // Campaign totals-to-date.
  totalLeads: number;
  totalContacted: number;
  totalReplied: number;
  totalDemosBooked: number;
  qualified: number;
  customers: number;
  replyRate: number;
  closeRate: number;
}

export interface DailyOpsNarrative {
  summary: string;
  wins: string[];
  problems: string[];
  recommendedActions: string[];
}

function buildNarrative(m: DailyOpsMetrics): DailyOpsNarrative {
  const wins: string[] = [];
  const problems: string[] = [];
  const recommended: string[] = [];

  if (m.demosBooked > 0) wins.push(`${m.demosBooked} demo${m.demosBooked === 1 ? "" : "s"} booked today.`);
  if (m.contacted > 0) wins.push(`Contacted ${m.contacted} prospect${m.contacted === 1 ? "" : "s"} today.`);
  if (m.replies > 0 && m.contacted > 0 && m.replyRate >= 20) wins.push(`Strong response rate: ${m.replyRate}% of contacted prospects have replied to date.`);

  if (m.leadsCreated === 0 && m.contacted === 0 && m.replies === 0) problems.push("No prospect activity today.");
  if (m.totalContacted > 0 && m.totalReplied === 0) problems.push("No prospects have replied to the campaign yet.");
  if (m.totalContacted > 0 && m.totalDemosBooked === 0) problems.push("No demos booked from the campaign yet.");
  if (m.qualified > 0 && m.customers === 0) problems.push("Qualified prospects have not converted to customers yet.");

  if (m.totalContacted > 0 && m.totalReplied === 0) recommended.push("Review the outreach copy — prospects are not replying.");
  if (m.totalReplied > 0 && m.totalDemosBooked === 0) recommended.push("Reach out to the prospects who replied but have not booked a demo.");
  if (m.contacted === 0 && m.totalLeads > 0) recommended.push("No outreach sent today — run the next follow-up step for the campaign leads.");
  if (recommended.length === 0 && m.totalLeads === 0) recommended.push("Import prospects (source=prospect_import) to start tracking the campaign.");

  const summary = `${m.leadsCreated} new prospect${m.leadsCreated === 1 ? "" : "s"} today, ${m.contacted} contacted, ${m.replies} repl${m.replies === 1 ? "y" : "ies"}, ${m.demosBooked} demo${m.demosBooked === 1 ? "" : "s"} booked. To date: ${m.totalLeads} prospects, ${m.totalContacted} contacted, ${m.totalReplied} replied, ${m.totalDemosBooked} demo${m.totalDemosBooked === 1 ? "" : "s"} booked, ${m.customers} customer${m.customers === 1 ? "" : "s"} (${m.closeRate}% close rate).`;

  return { summary, wins, problems, recommendedActions: recommended };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Aggregate the business's REAL prospect rows for the day [dayStart, dayStart+1d)
 * plus campaign totals-to-date. Pure aggregation — no LLM, no fabricated numbers.
 */
export async function computeDailyOpsMetrics(businessId: string, dayStart: number): Promise<DailyOpsMetrics> {
  const dayEnd = dayStart + DAY_MS;
  const nowMs = Date.now();

  const leads = await repo.listLeadsBySource(businessId, PROSPECT_IMPORT_SOURCE);
  const leadIds = leads.map((l) => l.id);

  const [appts, fups, convs] = await Promise.all([
    repo.listAppointmentsByLeadIds(businessId, leadIds),
    repo.listFollowUpsByLeadIds(businessId, leadIds),
    repo.listConversationsByLeadIds(businessId, leadIds),
  ]);
  const convIdToLeadId = new Map<string, string | null>(convs.map((c) => [c.id, c.leadId] as [string, string | null]));
  const msgs = await repo.listMessagesForConversations(businessId, [...convIdToLeadId.keys()], 0, nowMs + DAY_MS);

  // --- day-scoped -----------------------------------------------------------
  const leadsCreated = leads.filter((l) => l.createdAt >= dayStart && l.createdAt < dayEnd).length;

  const contactedDay = new Set<string>();
  let followupsSent = 0;
  for (const f of fups) {
    if (f.status === "sent" && f.updatedAt >= dayStart && f.updatedAt < dayEnd) {
      followupsSent += 1;
      if (f.leadId) contactedDay.add(f.leadId);
    }
  }
  for (const l of leads) {
    if (l.lastContactedAt != null && l.lastContactedAt >= dayStart && l.lastContactedAt < dayEnd) contactedDay.add(l.id);
  }

  const replies = msgs.filter((m) => m.sender === "lead" && m.createdAt >= dayStart && m.createdAt < dayEnd).length;

  const demosBooked = appts.filter((a) => a.createdAt >= dayStart && a.createdAt < dayEnd && ACTIVE_APPT_STATUSES.includes(a.status)).length;

  // --- totals-to-date -------------------------------------------------------
  const contactedEver = new Set<string>();
  for (const f of fups) {
    if (f.status === "sent" && f.leadId) contactedEver.add(f.leadId);
  }
  for (const l of leads) {
    if (l.lastContactedAt != null) contactedEver.add(l.id);
  }

  const repliedLeadIds = new Set<string>();
  for (const m of msgs) {
    if (m.sender !== "lead") continue;
    const leadId = convIdToLeadId.get(m.conversationId);
    if (leadId) repliedLeadIds.add(leadId);
  }

  const totalDemosBooked = appts.filter((a) => ACTIVE_APPT_STATUSES.includes(a.status)).length;
  const qualified = leads.filter((l) => QUALIFIED_STATUSES.includes(l.status)).length;
  const customers = leads.filter((l) => l.status === "customer").length;

  return {
    dayStart,
    dayEnd,
    leadsCreated,
    contacted: contactedDay.size,
    replies,
    followupsSent,
    demosBooked,
    totalLeads: leads.length,
    totalContacted: contactedEver.size,
    totalReplied: repliedLeadIds.size,
    totalDemosBooked,
    qualified,
    customers,
    replyRate: pct(repliedLeadIds.size, contactedEver.size),
    closeRate: pct(customers, qualified),
  };
}

/** Generate (and persist) the daily ops report for a business+day. Idempotent
 *  (upsert — regenerating a day replaces the stored report). */
export async function generateDailyOpsReport(businessId: string, dayStart?: number): Promise<{
  id: string;
  businessId: string;
  dayStart: number;
  dayEnd: number;
  metrics: DailyOpsMetrics;
  narrative: DailyOpsNarrative;
  createdAt: number;
}> {
  const start = dayStart ?? dayStartFor(Date.now() - DAY_MS); // previous completed day
  const metrics = await computeDailyOpsMetrics(businessId, start);
  const narrative = buildNarrative(metrics);
  const row = await repo.upsertDailyReport(businessId, start, metrics, narrative);
  await repo.logAgentAction(businessId, {
    agent: "bi",
    action: "daily_ops_report_generated",
    input: { dayStart: start, dayEnd: metrics.dayEnd },
    result: { reportId: row.id, leadsCreated: metrics.leadsCreated, demosBooked: metrics.demosBooked },
    success: true,
  });
  return { id: row.id, businessId, dayStart: metrics.dayStart, dayEnd: metrics.dayEnd, metrics, narrative, createdAt: row.createdAt };
}

/**
 * Daily timer body (dogfooding #9): for every business, generate the previous
 * day's report once it has fully ended and no report exists yet. Returns how
 * many reports were created. Mirrors runWeeklyReportJob's idempotent-create
 * pattern exactly (skip if the day already has a report).
 */
export async function runDailyOpsReportJob(nowMs = Date.now()): Promise<number> {
  if (!(await isAgentEnabled("bi"))) return 0;
  const prevDayStart = dayStartFor(nowMs - DAY_MS);
  const ids = await repo.listAllBusinessIds();
  let made = 0;
  for (const businessId of ids) {
    const existing = await repo.getDailyReport(businessId, prevDayStart);
    if (existing) continue;
    try {
      await generateDailyOpsReport(businessId, prevDayStart);
      made += 1;
    } catch (e) {
      console.error(`[bi] daily ops report failed for ${businessId}:`, e);
    }
  }
  return made;
}
