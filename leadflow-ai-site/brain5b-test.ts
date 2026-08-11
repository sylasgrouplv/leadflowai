/**
 * AI BRAIN 5b — agent performance + owner AI dashboard (§36–37), admin AI
 * control (§39), system health (§40) acceptance test.
 *
 * Exercises the NEW functionality THROUGH THE RUNNING SERVER
 * (http://localhost:3000 — run `bun run publish` first so the served code
 * includes this work):
 *
 *   A) Owner AI dashboard (GET /api/ai/dashboard): live metrics computed from
 *      real rows — shape, period handling, and real-data counting (a lead +
 *      conversation created this run must appear).
 *   B) Savings assumptions (PUT /api/ai/dashboard/savings) round-trip; the
 *      savings figure is ALWAYS flagged isEstimate=true (§37 — never actuals).
 *   C) System health (GET /api/health/system): 7 services, every service has
 *      status/kind/provider/detail; mock providers are labeled kind="mock"
 *      (never claim a live connection); the database check runs a real query.
 *   D) Admin AI control (GET/PUT /api/admin/ai): owners get 403; admins get
 *      switches + defaults + safety rules + stats; PUT persists agent switches
 *      and global defaults; unknown agent keys rejected (400); the change is
 *      audited (admin.ai_control_updated).
 *   E) Global switch is honored by the engine choke point: disabling the
 *      "receptionist" agent makes a NEW conversation start human-held
 *      (ai.active=false); re-enabling restores AI immediately.
 *
 * Auth: fresh owner signup per run (like brain5-test.ts); the SEEDED platform
 * admin (admin@leadflow.ai / admin1234 — never deleted) is used for the
 * admin-only checks. DB assertions read the local SQLite directly (shared
 * .data/leadflow.db). Cleanup deletes every row this run created and restores
 * any platform settings the admin PUT changed.
 *
 * Run:  cd /home/team/shared/site && bun run publish && bun run brain5b-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { eq, gte } from "drizzle-orm";
runMigrations();
const BASE = process.env.BRAIN5B_BASE ?? "http://localhost:3000";
const EMAIL = `brain5b_${Date.now()}@test.ai`;
const ADMIN_EMAIL = "admin@leadflow.ai";
const ADMIN_PASSWORD = "admin1234";
let cookie = "";
let userId = "";
let businessId = "";
let adminCookie = "";
let failures = 0;
/** Baseline: rows we must NOT delete at cleanup (pre-existing data). */
let auditBaseline = 0;
let platformSettingsBefore: { agents?: Record<string, boolean>; defaults?: { tone?: string; responseLength?: string; escalationSensitivity?: string } } = {};

async function api(path: string, opts: { method?: string; body?: unknown; auth?: string } = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(opts.auth ? { cookie: opts.auth } : cookie ? { cookie } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && !opts.auth) cookie = setCookie.split(";")[0];
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}

/** Open a conversation for a brand-new lead (owner session). */
async function newConversation(): Promise<{ leadId: string; convId: string }> {
  const r = await api("/api/leads", { method: "POST", body: { firstName: "Website", lastName: "Visitor", source: "brain5b_test", notes: "brain5b test lead" } });
  const leadId = r.json.lead?.id ?? r.json.id ?? "";
  if (!leadId) throw new Error("lead create failed: " + JSON.stringify(r.json).slice(0, 160));
  const c = await api("/api/chat/conversations", { method: "POST", body: { leadId, source: "brain5b_test" } });
  const convId = c.json.conversation?.id ?? "";
  if (!convId) throw new Error("conversation create failed: " + JSON.stringify(c.json).slice(0, 160));
  return { leadId, convId };
}

/** Delete every row a test business owns (tenant-scoped), mirroring brain5-test. */
async function wipeBusiness(db: ReturnType<typeof getDb>, id: string) {
  for (const lead of await db.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.businessId, id)).execute()) {
    for (const a of await db.select().from(s.appointments).where(eq(s.appointments.leadId, lead.id)).execute()) await db.delete(s.appointments).where(eq(s.appointments.id, a.id)).execute();
    await db.delete(s.followUps).where(eq(s.followUps.leadId, lead.id)).execute();
    for (const c of await db.select().from(s.conversations).where(eq(s.conversations.leadId, lead.id)).execute()) {
      await db.delete(s.messages).where(eq(s.messages.conversationId, c.id)).execute();
      await db.delete(s.conversations).where(eq(s.conversations.id, c.id)).execute();
    }
    await db.delete(s.agentActions).where(eq(s.agentActions.leadId, lead.id)).execute();
    await db.delete(s.leads).where(eq(s.leads.id, lead.id)).execute();
  }
  await db.delete(s.services).where(eq(s.services.businessId, id)).execute();
  await db.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, id)).execute();
  await db.delete(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, id)).execute();
  await db.delete(s.notifications).where(eq(s.notifications.businessId, id)).execute();
  await db.delete(s.usageEvents).where(eq(s.usageEvents.businessId, id)).execute();
  await db.delete(s.auditLogs).where(eq(s.auditLogs.businessId, id)).execute();
  await db.delete(s.widgetSettings).where(eq(s.widgetSettings.businessId, id)).execute();
  await db.delete(s.integrations).where(eq(s.integrations.businessId, id)).execute();
  await db.delete(s.subscriptions).where(eq(s.subscriptions.businessId, id)).execute();
  await db.delete(s.events).where(eq(s.events.businessId, id)).execute();
  await db.delete(s.automationRuns).where(eq(s.automationRuns.businessId, id)).execute();
  await db.delete(s.reviews).where(eq(s.reviews.businessId, id)).execute();
  await db.delete(s.businesses).where(eq(s.businesses.id, id)).execute();
}

(async () => {
  const db = getDb();
  auditBaseline = (await db.select().from(s.auditLogs).execute()).length;

  // ---------------------------------------------------------------- signup
  let r = await api("/api/auth/signup", { method: "POST", body: { name: "Brain5b Tester", email: EMAIL, password: "brain5b1234" } });
  userId = r.json.user?.id ?? r.json.id ?? "";
  pass("signup", r.status === 200 && !!userId, `status ${r.status}`);
  r = await api("/api/business", { method: "POST", body: { name: "Brain5b Plumbing Co", category: "plumbing" } });
  businessId = r.json.business?.id ?? r.json.id ?? "";
  pass("business created", (r.status === 200 || r.status === 201) && !!businessId, `status ${r.status}`);

  // ------------------------------------- A) owner AI dashboard (live metrics)
  r = await api("/api/ai/dashboard");
  const d0 = r.json ?? {};
  const m0 = d0.metrics ?? {};
  const requiredKeys = ["leadsCreated", "qualifiedLeads", "qualificationRate", "aiConversations", "totalConversations", "aiMessages", "humanMessages", "appointmentsBooked", "appointmentRate", "customers", "conversionRate", "escalations", "humanEscalationRate", "aiResolvedConversations", "aiResolutionRate", "avgResponseTimeMs", "followUpLeads", "followUpConversions", "followUpConversionRate", "estimatedRevenueCents", "revenueIsEstimate", "agents"];
  pass("A1 dashboard 200 + shape", r.status === 200 && d0.businessId === businessId && d0.periodDays === 30 && requiredKeys.every((k) => k in m0) && Array.isArray(m0.agents), `status=${r.status} keys=${requiredKeys.filter((k) => !(k in m0)).join(",") || "all"}`);
  pass("A2 revenue labeled estimate", m0.revenueIsEstimate === true && typeof m0.estimatedRevenueCents === "number", `rev=${m0.estimatedRevenueCents}`);
  pass("A3 savings estimate flag (§37)", d0.savings?.isEstimate === true && d0.savings?.note?.includes("Estimated"), `isEstimate=${d0.savings?.isEstimate}`);
  pass("A4 assumptions present", d0.assumptions && typeof d0.assumptions.humanHourlyCostCents === "number" && typeof d0.assumptions.minutesPerConversation === "number", JSON.stringify(d0.assumptions).slice(0, 120));

  // Real data must show up in the metrics: one lead + one conversation.
  const { convId } = await newConversation();
  r = await api("/api/ai/dashboard");
  const d1 = r.json.metrics ?? {};
  pass("A5 real rows counted", d1.leadsCreated >= 1 && d1.totalConversations >= 1, `leads=${d1.leadsCreated} convs=${d1.totalConversations}`);

  // Period window parameter.
  r = await api("/api/ai/dashboard?days=7");
  pass("A6 days param honored", r.status === 200 && r.json.periodDays === 7, `days=${r.json.periodDays}`);
  r = await api("/api/ai/dashboard?days=9999");
  pass("A7 out-of-range days clamped", r.status === 200 && r.json.periodDays === 30, `days=${r.json.periodDays}`);

  // ----------------------- B) savings assumptions round-trip (owner-configured)
  r = await api("/api/ai/dashboard/savings", { method: "PUT", body: { humanHourlyCostCents: 45000, minutesPerConversation: 20 } });
  pass("B1 PUT savings 200", r.status === 200 && r.json.assumptions?.humanHourlyCostCents === 45000 && r.json.assumptions?.minutesPerConversation === 20, `status=${r.status}`);
  r = await api("/api/ai/dashboard");
  pass("B2 savings persisted", r.json.assumptions?.humanHourlyCostCents === 45000 && r.json.assumptions?.minutesPerConversation === 20, JSON.stringify(r.json.assumptions).slice(0, 120));
  r = await api("/api/ai/dashboard/savings", { method: "PUT", body: { humanHourlyCostCents: -5 } });
  pass("B3 invalid savings rejected", r.status === 400, `status=${r.status}`);

  // ------------------------------------------- C) system health (§40)
  r = await api("/api/health/system");
  const svc = r.json.services ?? [];
  pass("C1 health 200 for owner", r.status === 200, `status=${r.status}`);
  pass("C2 seven services with full shape", svc.length === 7 && svc.every((x: any) => typeof x.id === "string" && ["CONNECTED", "ACTION REQUIRED"].includes(x.status) && ["ok", "mock", "action"].includes(x.kind) && typeof x.provider === "string" && typeof x.detail === "string"), `n=${svc.length}`);
  const aiSvc = svc.find((x: any) => x.id === "ai");
  pass("C3 mock provider labeled mock (never claims live)", aiSvc?.kind === "mock" && aiSvc?.provider === "mock" && aiSvc?.status === "CONNECTED", JSON.stringify(aiSvc).slice(0, 140));
  const dbSvc = svc.find((x: any) => x.id === "database");
  pass("C4 database live-query check ok", dbSvc?.kind === "ok" && dbSvc?.status === "CONNECTED", JSON.stringify(dbSvc).slice(0, 140));
  pass("C5 overall status valid", ["CONNECTED", "ACTION REQUIRED"].includes(r.json.overall) && typeof r.json.checkedAt === "number", `overall=${r.json.overall}`);

  // ------------------------------------------- D) admin AI control (§39)
  // D1: an owner must be rejected.
  r = await api("/api/admin/ai");
  pass("D1 owner GET /api/admin/ai -> 403", r.status === 403, `status=${r.status}`);
  // D2: seeded admin login + GET.
  const ar = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
  const setCookie = ar.headers.get("set-cookie");
  adminCookie = setCookie ? setCookie.split(";")[0] : "";
  pass("D2 admin login", ar.status === 200 && !!adminCookie, `status=${ar.status}`);
  r = await api("/api/admin/ai", { auth: adminCookie });
  const adm = r.json ?? {};
  const agents = adm.agents ?? {};
  const allKeys = ["receptionist", "qualification", "appointment", "followup", "review", "bi", "escalation"];
  pass("D3 admin GET 200 + agent switches", r.status === 200 && allKeys.every((k) => typeof agents[k] === "boolean"), `status=${r.status} keys=${allKeys.filter((k) => !(k in agents)).join(",") || "all"}`);
  pass("D4 global defaults + safety rules", adm.defaults?.tone && adm.safetyRules?.neverFabricate === true && adm.safetyRules?.aiNeverUsesHighRiskTools === true, JSON.stringify(adm.defaults).slice(0, 100));
  pass("D5 stats shape", typeof adm.stats?.escalations === "number" && typeof adm.stats?.escalationRate === "number" && typeof adm.stats?.monthUsage?.estimatedCostCents === "number" && Array.isArray(adm.agentErrors) && Array.isArray(adm.actionLogs) && Array.isArray(adm.failedAutomations), `escalations=${adm.stats?.escalations}`);
  platformSettingsBefore = { agents, defaults: adm.defaults };
  // D6: persist an agent switch + defaults.
  r = await api("/api/admin/ai", { method: "PUT", body: { agents: { review: false }, defaults: { tone: "Casual" } }, auth: adminCookie });
  pass("D6 PUT persists switches + defaults", r.status === 200 && r.json.agents?.review === false && r.json.defaults?.tone === "Casual", `status=${r.status}`);
  r = await api("/api/admin/ai", { auth: adminCookie });
  pass("D7 persisted on GET", r.json.agents?.review === false && r.json.defaults?.tone === "Casual", `agents.review=${r.json.agents?.review} tone=${r.json.defaults?.tone}`);
  // D8: unknown agent key rejected.
  r = await api("/api/admin/ai", { method: "PUT", body: { agents: { bogus: true } }, auth: adminCookie });
  pass("D8 unknown agent key -> 400", r.status === 400, `status=${r.status}`);
  // D9: audit row written for the admin action.
  const audits = (await db.select().from(s.auditLogs).execute()).slice(auditBaseline);
  pass("D9 admin change audited", audits.some((a) => a.action === "admin.ai_control_updated"), audits.map((a) => a.action).join(","));

  // -------------------- E) global receptionist switch gates the engine
  r = await api("/api/admin/ai", { method: "PUT", body: { agents: { receptionist: false } }, auth: adminCookie });
  pass("E1 admin disables receptionist", r.status === 200 && r.json.agents?.receptionist === false, `status=${r.status}`);
  {
    const { convId: conv2 } = await newConversation();
    const b = await api(`/api/chat/conversations/${conv2}`);
    const bb = b.json.bundle ?? b.json;
    pass("E2 new conversation starts human-held (ai.active=false)", bb.ai?.active === false, `active=${bb.ai?.active} status=${bb.conversation?.status}`);
  }
  r = await api("/api/admin/ai", { method: "PUT", body: { agents: { receptionist: true } }, auth: adminCookie });
  {
    const { convId: conv3 } = await newConversation();
    const b = await api(`/api/chat/conversations/${conv3}`);
    const bb = b.json.bundle ?? b.json;
    pass("E3 re-enabling restores AI (ai.active=true)", r.status === 200 && bb.ai?.active === true, `active=${bb.ai?.active}`);
  }

  // ------------------------------------------------ restore + report
  // Restore the platform settings the admin PUT changed (captured in D3).
  const restoreAgents = { ...platformSettingsBefore.agents, review: platformSettingsBefore.agents?.review ?? true, receptionist: platformSettingsBefore.agents?.receptionist ?? true };
  r = await api("/api/admin/ai", { method: "PUT", body: { agents: restoreAgents, defaults: { tone: platformSettingsBefore.defaults?.tone ?? "Professional", responseLength: platformSettingsBefore.defaults?.responseLength ?? "Medium", escalationSensitivity: platformSettingsBefore.defaults?.escalationSensitivity ?? "Balanced" } }, auth: adminCookie });
  r = await api("/api/admin/ai", { auth: adminCookie });
  pass("R1 platform settings restored", r.json.agents?.review === (platformSettingsBefore.agents?.review ?? true) && r.json.agents?.receptionist === (platformSettingsBefore.agents?.receptionist ?? true) && r.json.defaults?.tone === (platformSettingsBefore.defaults?.tone ?? "Professional"), `review=${r.json.agents?.review} tone=${r.json.defaults?.tone}`);

  console.log(failures === 0 ? "BRAIN5B-TEST: ALL PASS" : `BRAIN5B-TEST: ${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
// ------------------------------------------------------------------ cleanup
process.on("beforeExit", async () => {
  try {
    const db = getDb();
    // Remove audit rows this run created (admin + owner side effects).
    const rows = await db.select().from(s.auditLogs).execute();
    for (const a of rows.slice(auditBaseline)) {
      await db.delete(s.auditLogs).where(eq(s.auditLogs.id, a.id)).execute();
    }
    if (businessId) {
      for (const tm of await db.select().from(s.teamMembers).where(eq(s.teamMembers.businessId, businessId)).execute()) {
        await db.delete(s.sessions).where(eq(s.sessions.userId, tm.userId)).execute();
        await db.delete(s.teamMembers).where(eq(s.teamMembers.userId, tm.userId)).execute();
        await db.delete(s.users).where(eq(s.users.id, tm.userId)).execute();
      }
      await wipeBusiness(db, businessId);
    }
    if (userId) {
      await db.delete(s.sessions).where(eq(s.sessions.userId, userId)).execute();
      await db.delete(s.teamMembers).where(eq(s.teamMembers.userId, userId)).execute();
      await db.delete(s.users).where(eq(s.users.id, userId)).execute();
    }
    console.log("cleanup done");
  } catch {
    /* best-effort */
  }
});
