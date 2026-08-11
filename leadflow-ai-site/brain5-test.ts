/**
 * AI BRAIN 5a — agent config (§38) + usage & cost tracking (§32) acceptance test.
 *
 * Exercises the NEW functionality THROUGH THE RUNNING SERVER (http://localhost:3000 —
 * run `bun run publish` first so the served code includes this work):
 *
 *   A) Agent configuration round-trip (GET defaults / PUT new fields / legacy
 *      low|medium|high sensitivity backward-compat normalization).
 *   B) The config actually shapes replies: agentName signature, Casual tone
 *      marker, Short response-length cap (sentence counts).
 *   C) Escalation sensitivity semantics: Conservative keeps clarifying on
 *      uncertainty; Aggressive escalates early (human takeover).
 *   D) Usage events recorded for every AI reply (kind=ai_message, deterministic
 *      tokens + cost ≥ 1¢).
 *   E) Budget alerts at 80/90/100% — created once each (deduped by kind), the
 *      100% alert lands in the notifications surface.
 *   F) Runaway-stop: at 100% budget the AI stops auto-responding — the active
 *      conversation is paused and a NEW conversation starts human-held with a
 *      system note; raising the budget resumes AI immediately.
 *   G) SMS usage recording through the record_usage path (kind=sms).
 *   H) GET /api/ai/usage returns month usage + budget + percent + exhausted.
 *
 * Auth: fresh signup per run (like verify-fresh.ts). DB assertions read the
 * local SQLite directly (shared .data/leadflow.db, WAL mode). Cleanup deletes
 * every row this run created.
 *
 * Run:  cd /home/team/shared/site && bun run publish && bun run brain5-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { eq } from "drizzle-orm";
import { recordSmsUsage } from "./src/server/usage/record";
runMigrations();

const BASE = process.env.BRAIN5_BASE ?? "http://localhost:3000";
const EMAIL = `brain5_${Date.now()}@test.ai`;
let cookie = "";
let userId = "";
let businessId = "";
let failures = 0;

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
async function newConversation(): Promise<{ leadId: string; convId: string }> {
  const r = await api("/api/leads", { method: "POST", body: { firstName: "Website", lastName: "Visitor", source: "brain5_test", notes: "brain5 test lead" } });
  const leadId = r.json.lead?.id ?? r.json.id ?? "";
  if (!leadId) throw new Error("lead create failed: " + JSON.stringify(r.json).slice(0, 160));
  const c = await api("/api/chat/conversations", { method: "POST", body: { leadId, source: "brain5_test" } });
  const convId = c.json.conversation?.id ?? "";
  if (!convId) throw new Error("conversation create failed: " + JSON.stringify(c.json).slice(0, 160));
  return { leadId, convId };
}
/** Send a lead message and return the last AI reply + fresh bundle. */
async function chat(convId: string, body: string) {
  const r = await api(`/api/chat/conversations/${convId}/messages`, { method: "POST", body: { body, sender: "lead" } });
  const msgs: { sender: string; body: string }[] = r.json.messages ?? r.json.bundle?.messages ?? [];
  const aiReplies = msgs.filter((m) => m.sender === "ai").map((m) => m.body);
  const last = aiReplies.at(-1) ?? "";
  return { status: r.status, last, bundle: r.json.bundle ?? r.json };
}
function dbCount(kind: string): number {
  const db = getDb();
  switch (kind) {
    case "usage_ai":
      return db.select().from(s.usageEvents).where(eq(s.usageEvents.businessId, businessId)).all().filter((e) => e.kind === "ai_message").length;
    case "usage_sms":
      return db.select().from(s.usageEvents).where(eq(s.usageEvents.businessId, businessId)).all().filter((e) => e.kind === "sms").length;
    case "notif":
      return db.select().from(s.notifications).where(eq(s.notifications.businessId, businessId)).all().length;
    default:
      return 0;
  }
}
async function notifKinds(): Promise<string[]> {
  return getDb().select().from(s.notifications).where(eq(s.notifications.businessId, businessId)).all().map((n) => n.kind);
}

/** Delete every row a test business owns (tenant-scoped), mirroring cleanup. */
function wipeBusiness(db: ReturnType<typeof getDb>, id: string) {
  for (const lead of db.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.businessId, id)).all()) {
    for (const a of db.select().from(s.appointments).where(eq(s.appointments.leadId, lead.id)).all()) db.delete(s.appointments).where(eq(s.appointments.id, a.id)).run();
    db.delete(s.followUps).where(eq(s.followUps.leadId, lead.id)).run();
    for (const c of db.select().from(s.conversations).where(eq(s.conversations.leadId, lead.id)).all()) {
      db.delete(s.messages).where(eq(s.messages.conversationId, c.id)).run();
      db.delete(s.conversations).where(eq(s.conversations.id, c.id)).run();
    }
    db.delete(s.agentActions).where(eq(s.agentActions.leadId, lead.id)).run();
    db.delete(s.leads).where(eq(s.leads.id, lead.id)).run();
  }
  db.delete(s.services).where(eq(s.services.businessId, id)).run();
  db.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, id)).run();
  db.delete(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, id)).run();
  db.delete(s.notifications).where(eq(s.notifications.businessId, id)).run();
  db.delete(s.usageEvents).where(eq(s.usageEvents.businessId, id)).run();
  db.delete(s.auditLogs).where(eq(s.auditLogs.businessId, id)).run();
  db.delete(s.widgetSettings).where(eq(s.widgetSettings.businessId, id)).run();
  db.delete(s.integrations).where(eq(s.integrations.businessId, id)).run();
  db.delete(s.subscriptions).where(eq(s.subscriptions.businessId, id)).run();
  db.delete(s.events).where(eq(s.events.businessId, id)).run();
  db.delete(s.automationRuns).where(eq(s.automationRuns.businessId, id)).run();
  db.delete(s.reviews).where(eq(s.reviews.businessId, id)).run();
  db.delete(s.businesses).where(eq(s.businesses.id, id)).run();
}

(async () => {
  // ------------------------------------------------- rerunnability sweep
  // Remove any leftover test business from a previous run that was interrupted
  // before cleanup (killed mid-run), so usage_events/budget state can never
  // carry over between runs. Fresh runs are fully isolated either way.
  {
    const db = getDb();
    for (const b of db.select().from(s.businesses).where(eq(s.businesses.name, "Brain5 Plumbing Co")).all()) {
      for (const tm of db.select().from(s.teamMembers).where(eq(s.teamMembers.businessId, b.id)).all()) {
        db.delete(s.sessions).where(eq(s.sessions.userId, tm.userId)).run();
        db.delete(s.teamMembers).where(eq(s.teamMembers.userId, tm.userId)).run();
        db.delete(s.users).where(eq(s.users.id, tm.userId)).run();
      }
      wipeBusiness(db, b.id);
    }
  }
  // ---------------------------------------------------------------- signup
  let r = await api("/api/auth/signup", { method: "POST", body: { name: "Brain5 Tester", email: EMAIL, password: "brain51234" } });
  userId = r.json.user?.id ?? r.json.id ?? "";
  pass("signup", r.status === 200 && !!userId, `status ${r.status}`);
  r = await api("/api/business", { method: "POST", body: { name: "Brain5 Plumbing Co", category: "plumbing" } });
  businessId = r.json.business?.id ?? r.json.id ?? "";
  pass("business created", (r.status === 200 || r.status === 201) && !!businessId, `status ${r.status}`);
  await api("/api/business/service-area", { method: "PUT", body: { zipCodes: ["62701"], cities: ["Springfield"] } });
  const allDays: Record<string, { open: string; close: string; closed: boolean }> = {};
  for (const d of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) allDays[d] = { open: "08:00", close: "17:00", closed: false };
  await api("/api/business/hours", { method: "PUT", body: allDays });
  await api("/api/business/policies", { method: "PUT", body: { cancellationPolicy: "Free cancellation up to 24h before.", financing: "No financing offered.", promotions: "None.", welcomeMessage: "Hi! Thanks for reaching out to Brain5 Plumbing — how can we help?" } });
  await api("/api/services", { method: "POST", body: { name: "AC Repair", category: "ac", priceCents: 12900, description: "Diagnostic and repair", durationMins: 90 } });
  r = await api("/api/business/complete-onboarding", { method: "POST", body: {} });
  pass("onboarding", r.status === 200, `status ${r.status}`);

  // ------------------------------------------------ A) config round-trip
  r = await api("/api/ai/config");
  const cfg = r.json.config ?? {};
  pass("A1 defaults", r.status === 200 && cfg.agentName === "Sarah" && cfg.tone === "Professional" && cfg.responseLength === "Medium" && cfg.escalationSensitivity === "Balanced" && cfg.autoRespond === true && cfg.monthlyBudgetCents === 10000, JSON.stringify(cfg).slice(0, 150));
  r = await api("/api/ai/config", { method: "PUT", body: { escalationSensitivity: "medium" } });
  r = await api("/api/ai/config");
  pass("A2 legacy medium -> Balanced", (r.json.config ?? {}).escalationSensitivity === "Balanced", `got ${(r.json.config ?? {}).escalationSensitivity}`);
  r = await api("/api/ai/config", { method: "PUT", body: { agentName: "Casey", tone: "Casual", responseLength: "Short", escalationSensitivity: "Aggressive", monthlyBudgetCents: 100000, escalationKeywords: ["commercial job"], welcomeMessage: "Hi! This is Casey from Brain5 Plumbing — how can we help?" } });
  pass("A3 PUT all new fields", r.status === 200 && r.json.config?.agentName === "Casey" && r.json.config?.tone === "Casual" && r.json.config?.responseLength === "Short" && r.json.config?.escalationSensitivity === "Aggressive" && r.json.config?.monthlyBudgetCents === 100000 && r.json.welcomeMessage.includes("Casey"), JSON.stringify(r.json.config).slice(0, 150));

  // ------------------------------------------------ B) shaping takes effect
  await api("/api/ai/config", { method: "PUT", body: { escalationSensitivity: "Balanced" } });
  {
    const { convId } = await newConversation();
    await chat(convId, "My name is Dana, my phone is 555-0100, I live in 62701 and need AC repair");
    const q = await chat(convId, "How much does a new AC unit cost?");
    pass("B1 Casual tone marker", q.last.startsWith("Hey there!"), q.last.slice(0, 60));
    pass("B2 agentName signature", q.last.includes("Casey") && q.last.includes("Brain5 Plumbing"), q.last.slice(-90));
    const content = q.last.replace(/^Hey there! /, "").replace(/ — it's [A-Za-z]+ from .+!$/, "");
    const sentences = content.split(/(?<=[.!?])\s+/).filter((x) => x.trim().length > 0).length;
    pass("B3 Short caps content to 2 sentences", sentences <= 2, `${sentences} sentences: "${content.slice(0, 80)}"`);
  }

  // ------------------------------------------------ C) sensitivity semantics
  await api("/api/ai/config", { method: "PUT", body: { escalationSensitivity: "Conservative" } });
  {
    const { convId } = await newConversation();
    await chat(convId, "My name is Dana, my phone is 555-0100, I live in 62701 and need AC repair");
    const q = await chat(convId, "Tell me about quantum physics");
    const held = q.bundle.ai?.heldByHuman === true || q.bundle.conversation?.status === "human_takeover";
    pass("C1 Conservative keeps clarifying (no escalation)", !held && q.last.length > 0, `held=${held} status=${q.bundle.conversation?.status}`);
  }
  await api("/api/ai/config", { method: "PUT", body: { escalationSensitivity: "Aggressive" } });
  {
    const { convId } = await newConversation();
    await chat(convId, "My name is Dana, my phone is 555-0100, I live in 62701 and need AC repair");
    const q = await chat(convId, "Tell me about quantum physics");
    const held = q.bundle.ai?.heldByHuman === true || q.bundle.conversation?.status === "human_takeover";
    pass("C2 Aggressive escalates early on uncertainty", held === true, `held=${held} status=${q.bundle.conversation?.status}`);
  }
  await api("/api/ai/config", { method: "PUT", body: { escalationSensitivity: "Balanced", autoRespond: true } });
  // Regression: a casual greeting must classify as GENERAL_QUESTION and be
  // answered warmly — never UNKNOWN, which would false-escalate to a human
  // under Balanced sensitivity (spec §38: Balanced is the standard setting).
  {
    const { convId } = await newConversation();
    const q = await chat(convId, "hi there");
    const held = q.bundle.ai?.heldByHuman === true || q.bundle.conversation?.status === "human_takeover";
    pass("C3 casual greeting 'hi there' does not escalate under Balanced", !held && q.last.length > 0, `held=${held} status=${q.bundle.conversation?.status} reply="${q.last.slice(0, 60)}"`);
  }

  // ------------------------------------------------ D) usage on every reply
  {
    const { convId } = await newConversation();
    await chat(convId, "My name is Dana, my phone is 555-0100, I live in 62701 and need AC repair");
    await chat(convId, "How much does a new AC unit cost?");
    await chat(convId, "Do you offer financing?");
    const ai = dbCount("usage_ai");
    pass("D1 usage recorded per AI reply", ai >= 3, `${ai} ai_message events`);
    const db = getDb();
    const sample = db.select().from(s.usageEvents).where(eq(s.usageEvents.businessId, businessId)).all().find((e) => e.kind === "ai_message");
    pass("D2 deterministic tokens + cost", !!sample && sample.inputTokens > 0 && sample.outputTokens > 0 && sample.estimatedCostCents >= 1, sample ? `in=${sample.inputTokens} out=${sample.outputTokens} cost=${sample.estimatedCostCents}c` : "no event");
  }

  // ------------------------------------------------ G) SMS usage recording
  {
    const lead = getDb().select().from(s.leads).where(eq(s.leads.businessId, businessId)).all()[0];
    await recordSmsUsage({ businessId, leadId: lead?.id, agent: "test", body: "Brain5 SMS test" });
    pass("G1 SMS usage recorded", dbCount("usage_sms") >= 1, `${dbCount("usage_sms")} sms events`);
  }

  // ------------------------------------------------ E+F) budget alerts + runaway
  {
    const db = getDb();
    db.delete(s.usageEvents).where(eq(s.usageEvents.businessId, businessId)).run();
    db.delete(s.notifications).where(eq(s.notifications.businessId, businessId)).run();
  }
  await api("/api/ai/config", { method: "PUT", body: { monthlyBudgetCents: 15 } });
  {
    const { convId } = await newConversation();
    let last: { status: number; last: string; bundle: any } = { status: 0, last: "", bundle: {} };
    await chat(convId, "My name is Dana, my phone is 555-0100, I live in 62701 and need AC repair");
    for (let i = 0; i < 30; i++) {
      last = await chat(convId, "What are your hours?");
      const u = await api("/api/ai/usage");
      if (u.json.exhausted === true) break;
    }
    const u = await api("/api/ai/usage");
    pass("E1 usage endpoint reflects usage+budget+percent", u.status === 200 && u.json.budgetCents === 15 && u.json.usage.estimatedCostCents > 0 && typeof u.json.percentUsed === "number" && Array.isArray(u.json.alerts), `cost=${u.json.usage?.estimatedCostCents}c budget=15c pct=${u.json.percentUsed?.toFixed(1)}`);
    const kinds = await notifKinds();
    pass("E2 80/90/100% alerts created once (deduped)", ["usage_alert_80", "usage_alert_90", "usage_alert_100"].every((k) => kinds.filter((x) => x === k).length === 1), kinds.join(","));
    // The message that CROSSES 100% still gets answered (the gate is checked
    // before each reply); the NEXT inbound message is held for a human — the
    // pause must show up in that message's bundle and persist to the row.
    const paused = await chat(convId, "hello");
    pass("E3 conversation paused at 100% (aiEnabled=0)", paused.bundle.ai?.active === false, `active=${paused.bundle.ai?.active}`);
    const conv = getDb().select().from(s.conversations).where(eq(s.conversations.id, convId)).all()[0];
    pass("E3b aiEnabled=0 persisted", conv?.aiEnabled === 0, `aiEnabled=${conv?.aiEnabled}`);
    const { convId: conv2 } = await newConversation();
    const b = await api(`/api/chat/conversations/${conv2}`);
    const bb1 = b.json.bundle ?? b.json;
    pass("F1 new conversation starts human-held (no AI welcome)", bb1.ai?.active === false, `active=${bb1.ai?.active}`);
    const msgs2: { sender: string; body: string }[] = bb1.messages ?? [];
    pass("F2 system note explains the pause", msgs2.some((m) => m.sender === "system" && /budget/i.test(m.body)), msgs2.map((m) => m.sender).join(","));
    const before = dbCount("notif");
    await chat(conv2, "hello");
    const after = dbCount("notif");
    pass("F3 no alert spam while paused", after === before, `${before} -> ${after}`);
  }
  await api("/api/ai/config", { method: "PUT", body: { monthlyBudgetCents: 100000 } });
  {
    const { convId } = await newConversation();
    const b = await api(`/api/chat/conversations/${convId}`);
    const bb4 = b.json.bundle ?? b.json;
    pass("F4 raising budget resumes AI", bb4.ai?.active === true, `active=${bb4.ai?.active}`);
  }

  console.log(failures === 0 ? "BRAIN5-TEST: ALL PASS" : `BRAIN5-TEST: ${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
})();

// ------------------------------------------------------------------ cleanup
process.on("exit", () => {
  try {
    const db = getDb();
    if (businessId) {
      for (const tm of db.select().from(s.teamMembers).where(eq(s.teamMembers.businessId, businessId)).all()) {
        db.delete(s.sessions).where(eq(s.sessions.userId, tm.userId)).run();
        db.delete(s.teamMembers).where(eq(s.teamMembers.userId, tm.userId)).run();
        db.delete(s.users).where(eq(s.users.id, tm.userId)).run();
      }
      wipeBusiness(db, businessId);
    }
    if (userId) {
      db.delete(s.sessions).where(eq(s.sessions.userId, userId)).run();
      db.delete(s.teamMembers).where(eq(s.teamMembers.userId, userId)).run();
      db.delete(s.users).where(eq(s.users.id, userId)).run();
    }
    console.log("cleanup done");
  } catch {
    /* best-effort */
  }
});
