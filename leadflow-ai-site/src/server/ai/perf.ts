/**
 * AGENT PERFORMANCE METRICS + OWNER AI DASHBOARD (spec §36–37) — AI BRAIN 5b.
 *
 * Every number is computed from the business's REAL rows for the period
 * [periodStart, periodEnd) (default: trailing 30 days):
 *   - response time        first lead message → first AI message, per conversation
 *   - qualification rate   rubric-qualified leads (HOT/WARM) / leads created
 *   - appointment rate     leads with ≥1 active appointment / leads created
 *   - conversion rate      leads that became customers / leads created
 *   - human escalation     human tasks created / AI conversations
 *   - AI resolution rate   AI conversations never handed to a human / AI conversations
 *   - follow-up conversion leads that got a sent follow-up and then booked/closed
 *   - revenue attribution  booked jobs × configured average job value (§23)
 *     (ALWAYS labeled "estimated revenue", never presented as actuals)
 *   - AI savings estimate  aiResolved × minutesPerConversation assumption ×
 *     hourly cost assumption — clearly labeled an estimate (§37).
 *
 * No LLM, no sampling, no fabricated numbers.
 */
import * as repo from "../db/repo";
import { getDb } from "../db/client";
import * as s from "../db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

const ACTIVE_APPT_STATUSES = ["booked", "confirmed", "completed"] as const;
const QUALIFIED_CLASSIFICATIONS = ["HOT", "WARM"] as const;
const CONVERTED_STATUSES = ["appointment_booked", "customer"] as const;

export interface AgentPerformanceRow {
  agent: string;
  actions: number;
  success: number;
  failed: number;
  successRate: number; // 0-100
  lastActionAt: number | null;
}

export interface SavingsEstimate {
  /** Configured assumption: hourly cost of a human receptionist (cents). */
  humanHourlyCostCents: number;
  /** Configured assumption: minutes a human spends per handled conversation. */
  minutesPerConversation: number;
  /** AI-resolved conversations in the period. */
  aiResolvedConversations: number;
  /** Estimated human-hours saved (aiResolved × minutes / 60). */
  hoursSaved: number;
  /** Estimated savings in cents — an ESTIMATE, never a bill. */
  estimatedSavingsCents: number;
  /** Always true: this figure is an estimate built on configured assumptions. */
  isEstimate: true;
}

export interface AgentMetrics {
  periodStart: number;
  periodEnd: number;
  periodDays: number;
  businessName: string;
  leadsCreated: number;
  qualifiedLeads: number;
  qualificationRate: number; // 0-100
  aiConversations: number;
  totalConversations: number;
  aiMessages: number;
  humanMessages: number;
  appointmentsBooked: number; // active (booked/confirmed/completed) created in period
  appointmentRate: number; // leads with ≥1 active appointment / leads
  customers: number;
  conversionRate: number; // customers / leads
  escalations: number; // human tasks created in period
  humanEscalationRate: number; // escalations / AI conversations
  aiResolvedConversations: number;
  aiResolutionRate: number; // 0-100
  avgResponseTimeMs: number; // 0 when no measurable conversation
  followUpLeads: number; // leads with ≥1 sent follow-up
  followUpConversions: number; // of those, booked or customer
  followUpConversionRate: number; // 0-100
  /** Revenue attribution (§23): booked jobs × configured avg job value. */
  estimatedRevenueCents: number;
  agents: AgentPerformanceRow[];
  savings: SavingsEstimate;
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

export async function computeAgentMetrics(businessId: string, days = 30): Promise<AgentMetrics> {
  const end = Date.now();
  const start = end - days * 86_400_000;

  const [leads, appts, msgs, convs, fups, tasks, services, agentActions, business] = await Promise.all([
    repo.listLeadsCreatedBetween(businessId, start, end),
    repo.listAppointmentsCreatedBetween(businessId, start, end),
    repo.listMessagesBetween(businessId, start, end),
    repo.listConversationsBetween(businessId, start, end),
    repo.listFollowUpsBetween(businessId, start, end),
    repo.listHumanTasksBetween(businessId, start, end),
    repo.listServices(businessId),
    getDb()
      .select()
      .from(s.agentActions)
      .where(and(eq(s.agentActions.businessId, businessId), gte(s.agentActions.createdAt, start), sql`${s.agentActions.createdAt} < ${end}`))
      .orderBy(sql`${s.agentActions.createdAt} DESC`)
      .execute(),
    repo.getBusinessById(businessId),
  ]);

  const leadsCreated = leads.length;
  const leadIds = new Set(leads.map((l) => l.id));
  const qualifiedLeads = leads.filter((l) => QUALIFIED_CLASSIFICATIONS.includes(l.classification as never)).length;

  // Appointments: active statuses, created in the period.
  const activeAppts = appts.filter((a) => ACTIVE_APPT_STATUSES.includes(a.status as never));
  const appointmentsBooked = activeAppts.length;
  const leadsWithAppointment = new Set(activeAppts.map((a) => a.leadId).filter((id): id is string => !!id && leadIds.has(id))).size;
  const customers = leads.filter((l) => l.status === "customer").length;

  // Revenue attribution (§23): booked jobs × configured average job value.
  const svcById = new Map(services.map((sv) => [sv.id, sv]));
  const estimatedRevenueCents = activeAppts.reduce((sum, a) => sum + (a.serviceId ? repo.effectiveServiceValue(svcById.get(a.serviceId) ?? null) : 0), 0);

  // Conversations + AI resolution.
  type ConvRow = Awaited<ReturnType<typeof repo.listConversationsBetween>>[number];
  const convById = new Map<string, ConvRow>();
  for (const c of convs) convById.set(c.id, c);
  const aiMessages = msgs.filter((m) => m.sender === "ai").length;
  const humanMessages = msgs.filter((m) => m.sender === "employee").length;
  const aiConversationIds = new Set<string>();
  for (const m of msgs) if (m.sender === "ai" && convById.has(m.conversationId)) aiConversationIds.add(m.conversationId);
  const aiConversations = aiConversationIds.size;
  const totalConversations = convs.length;

  // Escalations: human tasks created in the period. Resolution: an AI
  // conversation counts as AI-resolved when it was never handed to a human —
  // status != human_takeover AND no escalation task references its lead.
  const escalatedLeadIds = new Set(tasks.map((t) => t.leadId).filter((id): id is string => !!id));
  let aiResolvedConversations = 0;
  for (const cid of aiConversationIds) {
    const conv = convById.get(cid);
    if (!conv) continue;
    if (conv.status === "human_takeover") continue;
    if (conv.leadId && escalatedLeadIds.has(conv.leadId)) continue;
    aiResolvedConversations += 1;
  }
  const escalations = tasks.length;

  // Average response time: first lead message → first AI message per conversation.
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

  // Follow-up conversion: leads (created in period) with ≥1 SENT follow-up that
  // went on to book an appointment or become a customer.
  const sentFollowUpLeadIds = new Set(fups.filter((f) => f.status === "sent").map((f) => f.leadId));
  const followUpLeads = [...sentFollowUpLeadIds].filter((id) => leadIds.has(id)).length;
  const followUpConversions = leads.filter((l) => sentFollowUpLeadIds.has(l.id) && CONVERTED_STATUSES.includes(l.status as never)).length;

  // Per-agent performance from the audit-logged tool registry (§24–25).
  const byAgent = new Map<string, { actions: number; success: number; failed: number; last: number }>();
  for (const a of agentActions) {
    const row = byAgent.get(a.agent) ?? { actions: 0, success: 0, failed: 0, last: 0 };
    row.actions += 1;
    if (a.success) row.success += 1;
    else row.failed += 1;
    if (a.createdAt > row.last) row.last = a.createdAt;
    byAgent.set(a.agent, row);
  }
  const agents: AgentPerformanceRow[] = [...byAgent.entries()]
    .map(([agent, v]) => ({
      agent,
      actions: v.actions,
      success: v.success,
      failed: v.failed,
      successRate: pct(v.success, v.actions),
      lastActionAt: v.last,
    }))
    .sort((a, b) => b.actions - a.actions);

  // Savings estimate (§37) — configured assumptions, clearly labeled.
  const assumptions = await repo.getSavingsAssumptions(businessId);
  const hoursSaved = Math.round((aiResolvedConversations * assumptions.minutesPerConversation * 10) / 60) / 10;
  const estimatedSavingsCents = Math.round(hoursSaved * assumptions.humanHourlyCostCents);

  return {
    periodStart: start,
    periodEnd: end,
    periodDays: days,
    businessName: business?.name ?? "",
    leadsCreated,
    qualifiedLeads,
    qualificationRate: pct(qualifiedLeads, leadsCreated),
    aiConversations,
    totalConversations,
    aiMessages,
    humanMessages,
    appointmentsBooked,
    appointmentRate: pct(leadsWithAppointment, leadsCreated),
    customers,
    conversionRate: pct(customers, leadsCreated),
    escalations,
    humanEscalationRate: pct(escalations, aiConversations),
    aiResolvedConversations,
    aiResolutionRate: pct(aiResolvedConversations, aiConversations),
    avgResponseTimeMs,
    followUpLeads,
    followUpConversions,
    followUpConversionRate: pct(followUpConversions, followUpLeads),
    estimatedRevenueCents,
    agents,
    savings: {
      humanHourlyCostCents: assumptions.humanHourlyCostCents,
      minutesPerConversation: assumptions.minutesPerConversation,
      aiResolvedConversations,
      hoursSaved,
      estimatedSavingsCents,
      isEstimate: true,
    },
  };
}
