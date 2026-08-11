/**
 * AI agent configuration routes (spec §38 agent config + §32 usage/cost +
 * §36–37 owner AI dashboard).
 *
 *   GET  /api/ai/config    owner: current receptionist config + welcome message
 *   PUT  /api/ai/config    owner: update agentName / tone / responseLength /
 *                                  escalationSensitivity / escalationKeywords /
 *                                  autoRespond / monthlyBudgetCents / welcomeMessage
 *   GET  /api/ai/usage     owner: current-month usage vs budget + alerts
 *   GET  /api/ai/dashboard owner: agent performance metrics + AI savings
 *                                  estimate (spec §36–37), ?days=30 default
 *   PUT  /api/ai/dashboard/savings
 *                          owner: configure savings assumptions (§37)
 *
 * The config is real and engine-backed:
 *   - agentName             -> chat UI sender name, widget header, signatures
 *   - tone / responseLength -> passed to the AI provider as generation params
 *   - escalationSensitivity -> fed into the orchestrator's escalate decision
 *                              (Conservative | Balanced | Aggressive; legacy
 *                              low/medium/high accepted and normalized)
 *   - escalationKeywords    -> owner phrases that always escalate
 *   - autoRespond           -> new conversations start AI-handled or human-held
 *   - monthlyBudgetCents    -> §32 monthly usage budget (alerts at 80/90/100%,
 *                              runaway-stop at 100%)
 *   - welcomeMessage        -> stored in the business policies (the same field
 *                              the engine reads for the first AI message)
 */
import { Hono } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, requireOwnerBusiness } from "../auth/guards";
import { checkBudgetAlerts, getBudgetStatus } from "../usage/budget";
import { computeAgentMetrics } from "../ai/perf";

const updateSchema = z.object({
  autoRespond: z.boolean().optional(),
  agentName: z.string().trim().min(1, "Agent name is required").max(60).optional(),
  tone: z.enum(["Professional", "Friendly", "Casual", "Concise"]).optional(),
  responseLength: z.enum(["Short", "Medium", "Detailed"]).optional(),
  // Legacy low/medium/high accepted for backward compatibility; normalized to
  // Conservative/Balanced/Aggressive by repo.saveAiConfig.
  escalationSensitivity: z.enum(["Conservative", "Balanced", "Aggressive", "low", "medium", "high"]).optional(),
  escalationKeywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  monthlyBudgetCents: z.number().int().min(0).max(100_000_000).optional(),
  welcomeMessage: z.string().max(2000).optional(),
});

export const aiRoutes = new Hono();
aiRoutes.use("*", attachUser);

aiRoutes.get("/config", async (c) => {
  const { business } = await requireOwnerBusiness(c);
  const config = await repo.getAiConfig(business.id);
  const policies = safeJson<{ welcomeMessage?: string }>(business.policiesJson, {});
  return c.json({ config, welcomeMessage: policies.welcomeMessage ?? "" });
});

aiRoutes.put("/config", async (c) => {
  const { business, user } = await requireOwnerBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const patch: Partial<repo.AiConfig> = {};
  if (parsed.data.autoRespond !== undefined) patch.autoRespond = parsed.data.autoRespond;
  if (parsed.data.agentName !== undefined) patch.agentName = parsed.data.agentName;
  if (parsed.data.tone !== undefined) patch.tone = parsed.data.tone;
  if (parsed.data.responseLength !== undefined) patch.responseLength = parsed.data.responseLength;
  if (parsed.data.escalationSensitivity !== undefined) {
    // Legacy low/medium/high accepted; saveAiConfig normalizes to the spec values.
    patch.escalationSensitivity = parsed.data.escalationSensitivity as repo.EscalationSensitivity;
  }
  if (parsed.data.escalationKeywords !== undefined) patch.escalationKeywords = parsed.data.escalationKeywords;
  if (parsed.data.monthlyBudgetCents !== undefined) patch.monthlyBudgetCents = parsed.data.monthlyBudgetCents;
  const config = await repo.saveAiConfig(business.id, patch);

  // Welcome message lives in the business policies — the same JSON the engine
  // reads when opening a new conversation (single source of truth).
  if (parsed.data.welcomeMessage !== undefined) {
    const current = safeJson<Record<string, unknown>>(business.policiesJson, {});
    await repo.updateBusiness(business.id, {
      policiesJson: JSON.stringify({ ...current, welcomeMessage: parsed.data.welcomeMessage }),
    });
  }

  await repo.audit(business.id, user.id, "ai.config_updated", "business", business.id, { patch: Object.keys(patch) });
  const fresh = await repo.getBusinessById(business.id);
  const policies = safeJson<{ welcomeMessage?: string }>(fresh?.policiesJson ?? "", {});
  return c.json({ config, welcomeMessage: policies.welcomeMessage ?? "" });
});

/** Owner-visible usage: current-month totals vs budget + alert state (§32). */
aiRoutes.get("/usage", async (c) => {
  const { business } = await requireOwnerBusiness(c);
  // Fire any threshold alerts that may have been missed (idempotent/deduped).
  await checkBudgetAlerts(business.id);
  const status = await getBudgetStatus(business.id);
  return c.json(status);
});

/** Owner AI dashboard (spec §36–37): live metrics computed from real rows. */
aiRoutes.get("/dashboard", async (c) => {
  const { business } = await requireOwnerBusiness(c);
  const daysParam = Number(c.req.query("days") ?? "30");
  const days = Number.isFinite(daysParam) && daysParam >= 1 && daysParam <= 365 ? Math.floor(daysParam) : 30;
  const metrics = await computeAgentMetrics(business.id, days);
  const assumptions = await repo.getSavingsAssumptions(business.id);
  return c.json({
    businessId: business.id,
    businessName: metrics.businessName,
    periodStart: metrics.periodStart,
    periodEnd: metrics.periodEnd,
    periodDays: metrics.periodDays,
    metrics: {
      leadsCreated: metrics.leadsCreated,
      qualifiedLeads: metrics.qualifiedLeads,
      qualificationRate: metrics.qualificationRate,
      aiConversations: metrics.aiConversations,
      totalConversations: metrics.totalConversations,
      aiMessages: metrics.aiMessages,
      humanMessages: metrics.humanMessages,
      appointmentsBooked: metrics.appointmentsBooked,
      appointmentRate: metrics.appointmentRate,
      customers: metrics.customers,
      conversionRate: metrics.conversionRate,
      escalations: metrics.escalations,
      humanEscalationRate: metrics.humanEscalationRate,
      aiResolvedConversations: metrics.aiResolvedConversations,
      aiResolutionRate: metrics.aiResolutionRate,
      avgResponseTimeMs: metrics.avgResponseTimeMs,
      followUpLeads: metrics.followUpLeads,
      followUpConversions: metrics.followUpConversions,
      followUpConversionRate: metrics.followUpConversionRate,
      // Revenue attribution (§23) — ALWAYS an estimate, never actuals.
      estimatedRevenueCents: metrics.estimatedRevenueCents,
      revenueIsEstimate: true,
      agents: metrics.agents,
    },
    savings: {
      ...metrics.savings,
      // §37 — clearly-labeled estimate: computed from configured assumptions.
      note: "Estimated savings based on your configured assumptions — not an actual accounting figure.",
    },
    assumptions,
    generatedAt: Date.now(),
  });
});

/** Owner-configured savings assumptions (§37) — stored per business. */
aiRoutes.put("/dashboard/savings", async (c) => {
  const { business, user } = await requireOwnerBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = savingsSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const assumptions = await repo.saveSavingsAssumptions(business.id, parsed.data);
  await repo.audit(business.id, user.id, "ai.dashboard_savings_updated", "business", business.id, { patch: parsed.data });
  return c.json({ assumptions });
});

const savingsSchema = z.object({
  humanHourlyCostCents: z.number().int().min(0).max(100_000_000).optional(),
  minutesPerConversation: z.number().int().min(1).max(600).optional(),
});

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
