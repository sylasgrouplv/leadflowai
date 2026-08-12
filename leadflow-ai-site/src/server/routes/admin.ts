/**
 * ADMIN AI CONTROL (spec §39) — platform-admin-only routes.
 *
 *   GET /api/admin/ai  admin: current agent switches + global defaults, recent
 *                             agent errors, action logs, platform AI usage,
 *                             escalation rates, failed automations.
 *   PUT /api/admin/ai  admin: update agent switches and/or global defaults.
 *
 * Security: every handler calls requireAdmin() — a business owner calling these
 * gets 403. Global safety rules are therefore platform-controlled; owners can
 * only configure their own business (routes/ai.ts §38).
 */
import { Hono } from "hono";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { attachUser, HttpError, requireAdmin } from "../auth/guards";
import * as repo from "../db/repo";
import { getDb } from "../db/client";
import * as s from "../db/schema";
import { count, desc, eq, inArray } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { ensureDefaultRulesForBusiness } from "../automations/rules";
import { emitEvent } from "../ai/events";
import { AGENT_KEYS, getAgentSwitches, getGlobalDefaults, setAgentSwitches, setGlobalDefaults, type AgentKey } from "../platform/settings";

export const adminRoutes = new Hono();
adminRoutes.use("*", attachUser);

const AGENT_KEYS_SET = new Set<string>(AGENT_KEYS);
const boolRecord = (label: string) => z.record(z.string(), z.boolean()).refine((v) => Object.keys(v).every((k) => AGENT_KEYS_SET.has(k)), `${label} contains unknown agent keys`);

const putSchema = z.object({
  agents: boolRecord("agents").optional(),
  defaults: z
    .object({
      tone: z.enum(["Professional", "Friendly", "Casual", "Concise"]).optional(),
      responseLength: z.enum(["Short", "Medium", "Detailed"]).optional(),
      escalationSensitivity: z.enum(["Conservative", "Balanced", "Aggressive"]).optional(),
    })
    .optional(),
});

async function businessNameMap(ids: Set<string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!ids.size) return map;
  const idList = [...ids];
  // Chunked inArray lookups (SQLite variable limit ~999 per query).
  const names = new Map<string, string>();
  for (let i = 0; i < idList.length; i += 500) {
    const chunk = idList.slice(i, i + 500);
    const rows = await getDb().select({ id: s.businesses.id, name: s.businesses.name }).from(s.businesses).where(inArray(s.businesses.id, chunk)).execute();
    for (const r of rows) names.set(r.id, r.name);
  }
  for (const id of idList) map.set(id, names.get(id) ?? "—");
  return map;
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function usageTotals(rows: { kind: string; inputTokens: number; outputTokens: number; estimatedCostCents: number }[]) {
  return rows.reduce(
    (acc, r) => {
      if (r.kind === "ai_message") acc.aiMessages += 1;
      else if (r.kind === "sms") acc.smsMessages += 1;
      else if (r.kind === "voice") acc.voiceMessages += 1;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.estimatedCostCents += r.estimatedCostCents;
      return acc;
    },
    { aiMessages: 0, smsMessages: 0, voiceMessages: 0, inputTokens: 0, outputTokens: 0, estimatedCostCents: 0 }
  );
}

adminRoutes.get("/ai", async (c) => {
  await requireAdmin(c);
  const db = getDb();
  const [agents, defaults, errors, actionLogs, failedRuns, usageRows, taskCount, aiConvRows] = await Promise.all([
    getAgentSwitches(),
    getGlobalDefaults(),
    db.select().from(s.agentActions).where(eq(s.agentActions.success, 0)).orderBy(desc(s.agentActions.createdAt)).limit(50).execute(),
    db.select().from(s.agentActions).orderBy(desc(s.agentActions.createdAt)).limit(50).execute(),
    repo.listFailedAutomationRuns(50),
    db.select().from(s.usageEvents).execute(),
    db.select({ n: count() }).from(s.humanTasks).execute(),
    db.select({ cid: s.messages.conversationId }).from(s.messages).where(eq(s.messages.sender, "ai")).execute(),
  ]);

  const bizIds = new Set<string>();
  for (const r of [...errors, ...actionLogs, ...failedRuns]) if (r.businessId) bizIds.add(r.businessId);
  const names = await businessNameMap(bizIds);

  const aiConversations = new Set(aiConvRows.map((r) => r.cid)).size;
  const escalations = taskCount[0]?.n ?? 0;
  const monthStart = repo.usageMonthStartMs();
  const monthEnd = repo.usageMonthEndMs(monthStart);
  const monthRows = usageRows.filter((r) => r.createdAt >= monthStart && r.createdAt < monthEnd);

  return c.json({
    agents,
    defaults,
    // "Global safety rules" — read-only snapshot surfaced for the admin (§39).
    safetyRules: {
      aiNeverUsesHighRiskTools: true,
      neverFabricate: true,
      neverInventAvailability: true,
      neverInventPricing: true,
      respectOptOuts: true,
      escalateUncertainty: true,
      protectPrivateInfo: true,
    },
    stats: {
      escalations,
      aiConversations,
      escalationRate: aiConversations > 0 ? Math.round((escalations / aiConversations) * 1000) / 10 : 0,
      failedAutomations: failedRuns.length,
      allTimeUsage: usageTotals(usageRows),
      monthUsage: usageTotals(monthRows),
      monthStart,
      monthEnd,
    },
    agentErrors: errors.map((r) => ({
      id: r.id,
      businessId: r.businessId,
      businessName: r.businessId ? names.get(r.businessId) ?? "—" : "—",
      agent: r.agent,
      action: r.action,
      input: safeJson(r.inputJson, {}),
      result: safeJson(r.resultJson, {}),
      createdAt: r.createdAt,
    })),
    actionLogs: actionLogs.map((r) => ({
      id: r.id,
      businessId: r.businessId,
      businessName: r.businessId ? names.get(r.businessId) ?? "—" : "—",
      agent: r.agent,
      action: r.action,
      success: r.success === 1,
      leadId: r.leadId,
      createdAt: r.createdAt,
    })),
    failedAutomations: failedRuns.map((r) => ({
      id: r.id,
      businessId: r.businessId,
      businessName: r.businessId ? names.get(r.businessId) ?? "—" : "—",
      ruleKind: r.ruleKind,
      status: r.status,
      lastError: r.lastError,
      attempts: r.attempts,
      createdAt: r.createdAt,
    })),
  });
});

adminRoutes.put("/ai", async (c) => {
  const user = await requireAdmin(c);
  const body = await c.req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  let agents: Record<AgentKey, boolean> | undefined;
  let defaults: { tone: string; responseLength: string; escalationSensitivity: string } | undefined;
  if (parsed.data.agents) agents = await setAgentSwitches(parsed.data.agents as Partial<Record<AgentKey, boolean>>);
  if (parsed.data.defaults) {
    const d = await setGlobalDefaults(parsed.data.defaults);
    defaults = { tone: d.tone, responseLength: d.responseLength, escalationSensitivity: d.escalationSensitivity };
  }
  await repo.audit(null, user.id, "admin.ai_control_updated", "platform", "", {
    agents: parsed.data.agents,
    defaults: parsed.data.defaults,
  });
  return c.json({
    agents: agents ?? (await getAgentSwitches()),
    defaults: defaults ?? (await getGlobalDefaults()),
  });
});

// ---------------------------------------------------------------------------
// ADMIN TENANT PROVISIONING — POST /api/admin/businesses (dogfooding Chunk A)
//
// Platform admins create a customer's business + owner account in one call,
// reusing the same repo helpers as db/seed.ts so behavior is identical to the
// seed script (owner user -> business -> team member -> integrations ->
// subscription -> widget settings -> default automation rules).
//
// Request:  { businessName, ownerEmail, ownerName, serviceArea?, services?,
//             knowledgeBase?, ownerPassword? }
// Response: { business, owner, temporaryPassword } — the temporary password is
//            generated when the caller doesn't supply one, and returned ONCE
//            so the admin can hand it to the customer.
// ---------------------------------------------------------------------------
const adminBusinessServiceSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  priceCents: z.number().int().min(0).max(100_000_000).optional(),
  durationMin: z.number().int().min(1).max(1440).optional(),
});
const adminBusinessKnowledgeSchema = z.object({
  kind: z.enum(s.KB_KINDS),
  question: z.string().max(300).optional(),
  answer: z.string().min(1).max(4000),
});
const adminBusinessSchema = z.object({
  businessName: z.string().min(2, "Business name is required").max(120),
  ownerEmail: z.string().email("A valid owner email is required").max(254),
  ownerName: z.string().min(1, "Owner name is required").max(120),
  /** Optional: when absent, a random temporary password is generated + returned once. */
  ownerPassword: z.string().min(8).max(128).optional(),
  serviceArea: z
    .object({
      zipCodes: z.array(z.string().max(12)).max(200).default([]),
      cities: z.array(z.string().max(80)).max(200).default([]),
    })
    .optional(),
  services: z.array(adminBusinessServiceSchema).max(20).optional(),
  knowledgeBase: z.array(adminBusinessKnowledgeSchema).max(50).optional(),
});

adminRoutes.post("/businesses", async (c) => {
  const user = await requireAdmin(c);
  const body = await c.req.json().catch(() => null);
  const parsed = adminBusinessSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const email = parsed.data.ownerEmail.toLowerCase();
  if (await repo.getUserByEmail(email)) throw new HttpError(409, "A user with that email already exists.");

  const temporaryPassword = parsed.data.ownerPassword ?? randomBytes(9).toString("base64url");
  const owner = await repo.createUser({
    name: parsed.data.ownerName,
    email,
    passwordHash: hashPassword(temporaryPassword),
    role: "owner",
  });
  const business = await repo.createBusiness({ ownerId: owner.id, name: parsed.data.businessName });

  if (parsed.data.serviceArea) {
    await repo.updateBusiness(business.id, { serviceAreaJson: JSON.stringify(parsed.data.serviceArea) });
  }
  for (const sv of parsed.data.services ?? []) {
    await repo.addService(business.id, {
      name: sv.name,
      description: sv.description ?? "",
      priceCents: sv.priceCents ?? 0,
      durationMin: sv.durationMin ?? 60,
    });
  }
  for (const k of parsed.data.knowledgeBase ?? []) {
    await repo.addKnowledge(business.id, { kind: k.kind, question: k.question ?? "", answer: k.answer });
  }

  // Same default rules the seed script guarantees (explicit, not lazy).
  await ensureDefaultRulesForBusiness(business.id);

  // Dogfooding Phase 2 — Chunk E: every new tenant gets its onboarding
  // setup-step reminders (knowledge base / calendar / services / widget at
  // day 1/3/7/14) through the default `onboarding_reminders` rule. The event
  // materializes a run for that rule; the engine schedules the reminders on
  // its next tick.
  await emitEvent({
    type: "BUSINESS_CREATED",
    businessId: business.id,
    payload: { businessName: business.name, ownerEmail: email },
  });

  await repo.audit(business.id, user.id, "admin.business.create", "business", business.id, {
    name: business.name,
    ownerEmail: email,
    services: parsed.data.services?.length ?? 0,
    knowledgeBase: parsed.data.knowledgeBase?.length ?? 0,
  });

  return c.json(
    {
      business: { id: business.id, name: business.name },
      owner: { id: owner.id, name: owner.name, email: owner.email },
      temporaryPassword,
    },
    201
  );
});
