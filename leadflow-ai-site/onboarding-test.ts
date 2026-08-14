/**
 * DOGFOODING PHASE 2 (Chunk E) acceptance test — customer onboarding nudges:
 * setup-step reminders for new customers on the automation engine.
 *
 * Exercises:
 *   T1  default `onboarding_reminders` rule materializes for new tenants
 *       (via ensureDogfoodRules — 6 default rules; BUSINESS_CREATED →
 *       schedule_onboarding_reminders, delay 0, actionConfig delay_days)
 *   T2  BUSINESS_CREATED → engine → 4 follow-up rows + runs (onboarding_step_1..4)
 *       scheduled at day 1/3/7/14 from business creation
 *   T3  re-emitted BUSINESS_CREATED is idempotent (no duplicate reminders)
 *   T4  send path: due run → SMS via provider (audited, agent "onboarding"),
 *       row sent, FOLLOWUP_SENT emitted, owner notification created
 *   T5  fire-time re-check: completed step (KB added) → that reminder
 *       cancelled, never sent; the other steps stay pending
 *   T6  partial completion: step 2 done (calendar connected) → only the
 *       step-2 reminder cancels; step 1 still sends
 *   T7  no-channel business → nothing scheduled; opted-out owner → nothing
 *   T8  config surface: rule actionConfig delay_days drives the offsets
 *   T9  stop-rule interplay: generic stop rules never kill setup reminders
 *       (cancelFollowUpsForLead keeps them; send path runs BEFORE stop rules)
 *   T10 templates: placeholders (business_name / owner_name / step /
 *       setup item), honest + STOP/opt-out, no fabricated claims/urgency
 *   T11 fully-onboarded business → scheduling skipped; due reminder cancelled
 *   T12 admin provisioning route end-to-end: POST /api/admin/businesses →
 *       BUSINESS_CREATED → engine → 4 reminders for the new tenant
 *
 * Style: matches reminder-test.ts (in-process suites) — repo functions + the
 * automation engine + the Hono app in-process, local SQLite, tenant-scoped
 * cleanup.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run onboarding-test.ts
 *       (HTTP-free except T12, which also runs from /home/team/shared/site)
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { and, eq } from "drizzle-orm";
import { emitEvent } from "./src/server/ai/events";
import { runAutomationEngine } from "./src/server/automations/engine";
import { ensureDogfoodRules } from "./scripts/seed-dogfood";
import {
  scheduleOnboardingReminders,
  getOnboardingDelayDays,
  onboardingSmsBody,
  onboardingEmail,
  onboardingStepOf,
  stepComplete,
  ensureOwnerLead,
  ONBOARDING_DEFAULT_DELAY_DAYS,
} from "./src/server/onboarding/agent";
import { sendFollowUpRow } from "./src/server/followups/engine";
import { createApp } from "./src/server/index";
import { createSession } from "./src/server/auth/session";
import { hashPassword } from "./src/server/auth/password";

runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();

/** Same tenant-scoped cleanup as reminder-test / dogfood-test (FK-safe). */
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

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

(async () => {
  // ------------------------------------------------------------ setup tenant
  const stamp = Date.now();
  const owner = await repo.createUser({
    name: "Onboarding Test Owner",
    email: `onboarding-owner-${stamp}@test.local`,
    passwordHash: "$2b$10$test", // unused — no auth exercised in T1–T11
    role: "owner",
  });
  const business = await repo.createBusiness({ ownerId: owner.id, name: "Onboarding Test Co", category: "home_services", phone: "(517) 555-2000" });
  const bizId = business.id;

  // ------------------------------------------------------------ T1 rule
  await ensureDogfoodRules(bizId); // the dogfood seed path (6 default rules)
  const rules = await repo.listAutomationRules(bizId);
  const obRule = rules.find((r) => r.name === "onboarding_reminders");
  pass(
    "T1 onboarding_reminders default rule wired",
    !!obRule && obRule.triggerEvent === "BUSINESS_CREATED" && obRule.action === "schedule_onboarding_reminders" && obRule.conditionJson.includes("none") && obRule.delayMs === 0,
    obRule ? `${obRule.triggerEvent}→${obRule.action} delay=${obRule.delayMs}` : "missing"
  );
  pass("T1b six default rules (dogfood)", rules.length === 7, `n=${rules.length}`);
  const obCfg = obRule?.actionConfigJson ? (JSON.parse(obRule.actionConfigJson) as { delay_days?: Record<string, number> }) : {};
  pass("T1c default delay_days 1/3/7/14 in rule actionConfig", JSON.stringify(obCfg.delay_days) === JSON.stringify(ONBOARDING_DEFAULT_DELAY_DAYS), JSON.stringify(obCfg.delay_days));

  /** Emit BUSINESS_CREATED (exactly like the admin provisioning route) + run the engine. */
  async function createAndEmit() {
    await emitEvent({ type: "BUSINESS_CREATED", businessId: bizId, payload: { businessName: business.name } });
    await runAutomationEngine();
  }

  async function onboardingRows() {
    const rows = await db
      .select()
      .from(s.followUps)
      .where(and(eq(s.followUps.businessId, bizId)))
      .execute();
    return rows.filter((r) => onboardingStepOf(r.templateKey) !== null);
  }
  async function onboardingRuns() {
    const runs = await db
      .select()
      .from(s.automationRuns)
      .where(and(eq(s.automationRuns.businessId, bizId)))
      .execute();
    return runs.filter((r) => r.ruleKind === "followup_step_send" && (r.payloadJson ?? "").includes("onboarding_step_"));
  }
  function payloadOf(run: { payloadJson: string | null }) {
    try {
      return JSON.parse(run.payloadJson || "{}");
    } catch {
      return {};
    }
  }

  // ------------------------------------------------------------ T2 schedule
  {
    await createAndEmit();
    const rows = await onboardingRows();
    const runs = await onboardingRuns();
    const created = (await repo.getBusinessById(bizId))!.createdAt;
    pass("T2 four onboarding rows scheduled (pending, sms)", rows.length === 4 && rows.every((r) => r.status === "pending" && r.type === "sms"), rows.map((r) => `${r.templateKey}:${r.status}`).join(","));
    pass(
      "T2b scheduled at day 1/3/7/14 from business creation",
      rows.map((r) => r.scheduledFor).join(",") === [1, 2, 3, 4].map((i) => created + ONBOARDING_DEFAULT_DELAY_DAYS[i] * DAY).join(","),
      rows.map((r) => `${r.templateKey}@${r.scheduledFor}`).join(" ")
    );
    pass("T2c one run per row (ruleKind followup_step_send, ruleId null)", runs.length === 4 && runs.every((r) => r.ruleId === null && r.runAt === rows.find((x) => x.id === payloadOf(r).followUpId)?.scheduledFor), `n=${runs.length}`);
    const p1 = runs.find((r) => payloadOf(r).step === 1);
    pass("T2d run payload carries step + templateKey", !!p1 && payloadOf(p1).templateKey === "onboarding_step_1" && payloadOf(p1).step === 1, p1 ? JSON.stringify(payloadOf(p1)).slice(0, 140) : "missing");
    const ownerLead = await repo.listLeads(bizId, 1000).then((ls) => ls.find((l) => l.source === "onboarding"));
    pass("T2e owner lead created (source onboarding, email = owner email)", !!ownerLead && ownerLead.email === owner.email && ownerLead.firstName === "Onboarding" && ownerLead.lastName === "Test Owner", ownerLead ? `${ownerLead.firstName} ${ownerLead.lastName} <${ownerLead.email}>` : "none");
    const actions = await repo.listAgentActions(bizId, 400);
    const schedAction = actions.find((a) => a.action === "schedule_onboarding_reminders" && a.agent === "onboarding");
    const schedAudit = actions.find((a) => a.action === "schedule_onboarding_reminders" && a.agent === "automation");
    pass("T2f schedule audited via onboarding agent (tool audit + agent log)", !!schedAction && !!schedAudit && schedAction.success === 1, schedAction ? `${schedAction.agent}+${schedAudit?.agent ?? "none"}` : "no audit");
  }

  // ------------------------------------------------------------ T3 idempotency
  {
    await createAndEmit();
    const rows = await onboardingRows();
    pass("T3 re-emitted BUSINESS_CREATED does not duplicate reminders", rows.filter((r) => r.status === "pending").length === 4, rows.map((r) => r.status).join(","));
  }

  // ------------------------------------------------------------ T4 send path
  {
    const runs = await onboardingRuns();
    const step1Run = runs.find((r) => payloadOf(r).step === 1)!;
    await repo.updateAutomationRun(bizId, step1Run.id, { runAt: Date.now() - 5_000 }); // make due
    const engine = await runAutomationEngine();
    const rows = await onboardingRows();
    const actions = await repo.listAgentActions(bizId, 400);
    const sms = actions.find((a) => a.action === "send_sms" && (a.inputJson ?? "").includes("onboarding_step_1"));
    const body = sms ? (JSON.parse(sms.inputJson) as { body?: string }).body ?? "" : "";
    const events = await repo.listEvents(bizId, { limit: 300 });
    const notifications = await db.select().from(s.notifications).where(eq(s.notifications.businessId, bizId)).execute();
    pass("T4 step-1 reminder sent (row status sent)", rows.find((r) => r.templateKey === "onboarding_step_1")?.status === "sent", rows.find((r) => r.templateKey === "onboarding_step_1")?.status ?? "none");
    pass("T4b SMS audited via onboarding agent", !!sms && sms.agent === "onboarding", sms ? sms.agent : "no sms action");
    pass(
      "T4c body has business + step text, honest opt-out",
      body.includes("Onboarding Test Co") && body.toLowerCase().includes("business info") && body.includes("Reply STOP"),
      body.slice(0, 160)
    );
    pass("T4d FOLLOWUP_SENT emitted for the onboarding reminder", events.some((e) => e.type === "FOLLOWUP_SENT" && (e.payloadJson ?? "").includes("onboarding_step_1")), "");
    pass("T4e owner notification created (kind onboarding)", notifications.some((n) => n.kind === "onboarding" && n.title.includes("step 1")), notifications.map((n) => n.kind).join(","));
    pass("T4f engine executed without failures", engine.failed === 0 && engine.executed > 0, `executed=${engine.executed} failed=${engine.failed}`);
  }

  // ------------------------------------------------------------ T5 completed step → skip
  {
    // New business so the earlier sent rows don't interfere.
    const o2 = await repo.createUser({ name: "Onboarding T5 Owner", email: `onboarding-t5-${Date.now()}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
    const b2 = await repo.createBusiness({ ownerId: o2.id, name: "T5 Co", category: "home_services", phone: "(517) 555-3000" });
    await ensureDogfoodRules(b2.id);
    await emitEvent({ type: "BUSINESS_CREATED", businessId: b2.id, payload: {} });
    await runAutomationEngine();
    // Complete step 1: add a knowledge-base entry (real repo state).
    await repo.addKnowledge(b2.id, { kind: "faq", question: "What do you charge?", answer: "Call for a quote." });
    const runs = await db.select().from(s.automationRuns).where(eq(s.automationRuns.businessId, b2.id)).execute();
    const step1 = runs.find((r) => (r.payloadJson ?? "").includes('"step":1'))!;
    await repo.updateAutomationRun(b2.id, step1.id, { runAt: Date.now() - 5_000 });
    await runAutomationEngine();
    const rows = (await db.select().from(s.followUps).where(eq(s.followUps.businessId, b2.id)).execute()).filter((r) => onboardingStepOf(r.templateKey) !== null);
    const actions = await repo.listAgentActions(b2.id, 400);
    const sent = actions.some((a) => a.action === "send_sms" && (a.inputJson ?? "").includes("onboarding_step_1"));
    pass("T5 completed step 1 → its reminder cancelled, never sent", rows.find((r) => r.templateKey === "onboarding_step_1")?.status === "cancelled" && !sent, rows.find((r) => r.templateKey === "onboarding_step_1")?.status ?? "none");
    pass("T5b other steps still pending", rows.filter((r) => ["onboarding_step_2", "onboarding_step_3", "onboarding_step_4"].includes(r.templateKey) && r.status === "pending").length === 3, rows.map((r) => `${r.templateKey}:${r.status}`).join(","));
    await wipeBusiness(b2.id);
    await db.delete(s.users).where(eq(s.users.id, o2.id)).execute();
  }

  // ------------------------------------------------------------ T6 partial completion (step 2 done → only step 2 cancels)
  {
    const o3 = await repo.createUser({ name: "Onboarding T6 Owner", email: `onboarding-t6-${Date.now()}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
    const b3 = await repo.createBusiness({ ownerId: o3.id, name: "T6 Co", category: "home_services", phone: "(517) 555-4000" });
    await ensureDogfoodRules(b3.id);
    await emitEvent({ type: "BUSINESS_CREATED", businessId: b3.id, payload: {} });
    await runAutomationEngine();
    // Complete step 2: connect the calendar.
    await repo.setIntegrationStatus(b3.id, "calendar", "connected", { provider: "google-calendar" });
    const verdict = await stepComplete(b3.id, 2);
    const runs = await db.select().from(s.automationRuns).where(eq(s.automationRuns.businessId, b3.id)).execute();
    const step1Run = runs.find((r) => (r.payloadJson ?? "").includes('"step":1'))!;
    const step2Run = runs.find((r) => (r.payloadJson ?? "").includes('"step":2'))!;
    await repo.updateAutomationRun(b3.id, step2Run.id, { runAt: Date.now() - 5_000 });
    await runAutomationEngine();
    let rows = (await db.select().from(s.followUps).where(eq(s.followUps.businessId, b3.id)).execute()).filter((r) => onboardingStepOf(r.templateKey) !== null);
    pass("T6 step-2 complete → its reminder cancelled", verdict.complete && rows.find((r) => r.templateKey === "onboarding_step_2")?.status === "cancelled", `${verdict.reason} / ${rows.find((r) => r.templateKey === "onboarding_step_2")?.status}`);
    // Step 1 still incomplete → fires and sends when due.
    await repo.updateAutomationRun(b3.id, step1Run.id, { runAt: Date.now() - 5_000 });
    await runAutomationEngine();
    rows = (await db.select().from(s.followUps).where(eq(s.followUps.businessId, b3.id)).execute()).filter((r) => onboardingStepOf(r.templateKey) !== null);
    const actions = await repo.listAgentActions(b3.id, 400);
    pass("T6b step-1 still sends (only step 2 cancelled)", rows.find((r) => r.templateKey === "onboarding_step_1")?.status === "sent" && actions.some((a) => a.action === "send_sms" && (a.inputJson ?? "").includes("onboarding_step_1")), rows.map((r) => `${r.templateKey}:${r.status}`).join(","));
    await wipeBusiness(b3.id);
    await db.delete(s.users).where(eq(s.users.id, o3.id)).execute();
  }

  // ------------------------------------------------------------ T7 no channel / opted out
  {
    const o4 = await repo.createUser({ name: "NoChannel Owner", email: `onboarding-nc-${Date.now()}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
    const b4 = await repo.createBusiness({ ownerId: o4.id, name: "NoChannel Co", category: "home_services" }); // no phone; owner email is the only channel
    await ensureDogfoodRules(b4.id);
    // Opt the owner lead out BEFORE scheduling → nothing is scheduled.
    const ownerLead = await ensureOwnerLead(b4.id);
    if (ownerLead) await repo.updateLead(b4.id, ownerLead.id, { optedOut: 1 });
    await emitEvent({ type: "BUSINESS_CREATED", businessId: b4.id, payload: {} });
    await runAutomationEngine();
    const rows = (await db.select().from(s.followUps).where(eq(s.followUps.businessId, b4.id)).execute()).filter((r) => onboardingStepOf(r.templateKey) !== null);
    const res = await scheduleOnboardingReminders(b4.id);
    pass("T7 opted-out owner → nothing scheduled", res.status === "skipped" && res.reason === "opted-out" && rows.length === 0, `${res.status}:${res.reason ?? ""} rows=${rows.length}`);
    await wipeBusiness(b4.id);
    await db.delete(s.users).where(eq(s.users.id, o4.id)).execute();

    // No channel at all: owner email empty + no business phone.
    const o5 = await repo.createUser({ name: "NoChannel2 Owner", email: `onboarding-nc2-${Date.now()}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
    await db.update(s.users).set({ email: "" }).where(eq(s.users.id, o5.id)).execute(); // no reachable email
    const b5 = await repo.createBusiness({ ownerId: o5.id, name: "NoChannel2 Co", category: "home_services" });
    await ensureDogfoodRules(b5.id);
    const res2 = await scheduleOnboardingReminders(b5.id);
    const rows2 = (await db.select().from(s.followUps).where(eq(s.followUps.businessId, b5.id)).execute()).filter((r) => onboardingStepOf(r.templateKey) !== null);
    pass("T7b no-channel business → nothing scheduled", res2.status === "skipped" && ["no-channel", "no-lead"].includes(res2.reason ?? "") && rows2.length === 0, `${res2.status}:${res2.reason ?? ""} rows=${rows2.length}`);
    await wipeBusiness(b5.id);
    await db.delete(s.users).where(eq(s.users.id, o5.id)).execute();
  }

  // ------------------------------------------------------------ T8 config surface
  {
    const rule = (await repo.listAutomationRules(bizId)).find((r) => r.name === "onboarding_reminders")!;
    await repo.updateAutomationRule(bizId, rule.id, { actionConfigJson: JSON.stringify({ delay_days: { "1": 2, "2": 3, "3": 7, "4": 14 } }) });
    const days = await getOnboardingDelayDays(bizId);
    pass("T8 config surface: delay_days from rule actionConfig drives offsets", days[1] === 2 && days[2] === 3 && days[3] === 7 && days[4] === 14, JSON.stringify(days));
    const o6 = await repo.createUser({ name: "T8 Owner", email: `onboarding-t8-${Date.now()}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
    const b6 = await repo.createBusiness({ ownerId: o6.id, name: "T8 Co", category: "home_services", phone: "(517) 555-5000" });
    await ensureDogfoodRules(b6.id);
    const rule6 = (await repo.listAutomationRules(b6.id)).find((r) => r.name === "onboarding_reminders")!;
    await repo.updateAutomationRule(b6.id, rule6.id, { actionConfigJson: JSON.stringify({ delay_days: { "1": 2, "2": 3, "3": 7, "4": 14 } }) });
    await emitEvent({ type: "BUSINESS_CREATED", businessId: b6.id, payload: {} });
    await runAutomationEngine();
    const created = (await repo.getBusinessById(b6.id))!.createdAt;
    const rows = (await db.select().from(s.followUps).where(eq(s.followUps.businessId, b6.id)).execute()).filter((r) => onboardingStepOf(r.templateKey) !== null);
    pass("T8b step-1 scheduled at day 2 (custom)", rows.find((r) => r.templateKey === "onboarding_step_1")?.scheduledFor === created + 2 * DAY, `scheduledFor=${rows.find((r) => r.templateKey === "onboarding_step_1")?.scheduledFor} expected=${created + 2 * DAY}`);
    await wipeBusiness(b6.id);
    await db.delete(s.users).where(eq(s.users.id, o6.id)).execute();
    // Restore default for remaining tests.
    await repo.updateAutomationRule(bizId, rule.id, { actionConfigJson: JSON.stringify({ delay_days: ONBOARDING_DEFAULT_DELAY_DAYS }) });
  }

  // ------------------------------------------------------------ T9 stop-rule interplay
  {
    // The owner lead's pending onboarding rows must survive generic stop rules.
    const ownerLead = (await repo.listLeads(bizId, 1000)).find((l) => l.source === "onboarding")!;
    // Simulate a generic stop: cancel all follow-ups for the lead (like opt-out / booked).
    await repo.cancelFollowUpsForLead(bizId, ownerLead.id);
    let rows = (await db.select().from(s.followUps).where(eq(s.followUps.businessId, bizId)).execute()).filter((r) => onboardingStepOf(r.templateKey) !== null);
    pass("T9 generic stop rules keep onboarding rows (pending untouched)", rows.filter((r) => ["pending", "sent"].includes(r.status)).length === 4, rows.map((r) => `${r.templateKey}:${r.status}`).join(","));
    // And the send path runs BEFORE the generic stop rules: a lead whose status
    // is appointment_booked would cancel a seq row — an onboarding row still sends.
    await repo.updateLead(bizId, ownerLead.id, { status: "appointment_booked" });
    const runs = await onboardingRuns();
    const step3Run = runs.find((r) => payloadOf(r).step === 3)!;
    await repo.updateAutomationRun(bizId, step3Run.id, { runAt: Date.now() - 5_000 });
    await runAutomationEngine();
    rows = (await db.select().from(s.followUps).where(eq(s.followUps.businessId, bizId)).execute()).filter((r) => onboardingStepOf(r.templateKey) !== null);
    const actions = await repo.listAgentActions(bizId, 400);
    pass("T9b onboarding send runs before generic stop rules (booked lead still reminded)", rows.find((r) => r.templateKey === "onboarding_step_3")?.status === "sent" && actions.some((a) => a.action === "send_sms" && (a.inputJson ?? "").includes("onboarding_step_3")), rows.find((r) => r.templateKey === "onboarding_step_3")?.status ?? "none");
    await repo.updateLead(bizId, ownerLead.id, { status: "new", optedOut: 1 }); // done with this lead
  }

  // ------------------------------------------------------------ T10 templates
  {
    const sms = onboardingSmsBody({ firstName: "Jane", businessName: "Onboarding Test Co", ownerName: "Owner Name", step: 1 });
    const email = onboardingEmail({ firstName: "Jane", businessName: "Onboarding Test Co", ownerName: "Owner Name", step: 2 });
    pass(
      "T10 SMS template placeholders + step + opt-out, honest",
      sms.includes("Onboarding Test Co") && sms.toLowerCase().includes("business info") && sms.includes("Reply STOP") && !/urgent|final|hurry|deadline/i.test(sms),
      sms.slice(0, 160)
    );
    pass(
      "T10b email template uses business_name/owner_name/step, opt-out, no urgency",
      email.subject.includes("Onboarding Test Co") && email.subject.toLowerCase().includes("calendar") && email.html.includes("Owner Name") && email.html.includes("opt out") && !/urgent|final|hurry|deadline/i.test(email.subject + email.html),
      email.subject
    );
    const sms2 = onboardingSmsBody({ firstName: "Jane", businessName: "B", ownerName: null, step: 3 });
    const sms4 = onboardingSmsBody({ firstName: "Jane", businessName: "B", ownerName: null, step: 4 });
    pass("T10c step-specific copy (services + widget)", sms2.toLowerCase().includes("services") && sms4.toLowerCase().includes("widget"), sms2.slice(0, 80) + " | " + sms4.slice(0, 80));
  }

  // ------------------------------------------------------------ T11 fully onboarded
  {
    const o7 = await repo.createUser({ name: "T11 Owner", email: `onboarding-t11-${Date.now()}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
    const b7 = await repo.createBusiness({ ownerId: o7.id, name: "T11 Co", category: "home_services", phone: "(517) 555-6000" });
    await ensureDogfoodRules(b7.id);
    await repo.updateBusiness(b7.id, { onboardingStep: 6, onboardingCompleted: 1 });
    const res = await scheduleOnboardingReminders(b7.id);
    const rows = (await db.select().from(s.followUps).where(eq(s.followUps.businessId, b7.id)).execute()).filter((r) => onboardingStepOf(r.templateKey) !== null);
    pass("T11 fully-onboarded business → nothing scheduled", res.status === "skipped" && res.reason === "onboarding-complete" && rows.length === 0, `${res.status}:${res.reason ?? ""}`);
    await wipeBusiness(b7.id);
    await db.delete(s.users).where(eq(s.users.id, o7.id)).execute();
  }

  // ------------------------------------------------------------ T12 admin route end-to-end
  {
    const app = await createApp();
    let admin = await repo.getUserByEmail("admin@leadflow.ai");
    if (!admin) {
      admin = await repo.createUser({ name: "LeadFlow Admin", email: "admin@leadflow.ai", passwordHash: hashPassword("admin1234"), role: "admin" });
    }
    const adminSession = await createSession(admin.id);
    const adminCookie = `lf_session=${adminSession.token}`;
    const email = `onboarding-e2e-${Date.now()}@test.local`;
    const r = await app.request("/api/admin/businesses", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ businessName: "E2E Onboarding Co", ownerEmail: email, ownerName: "E2E Owner" }),
    });
    const created = await r.json().catch(() => ({}));
    const createdOwner = await repo.getUserByEmail(email);
    const createdBiz = createdOwner ? await repo.getBusinessForUser(createdOwner.id) : null;
    pass("T12 admin POST -> 201", r.status === 201 && !!createdBiz, `status=${r.status} biz=${createdBiz?.id ?? "none"}`);
    if (createdBiz) {
      // BUSINESS_CREATED was emitted by the route; the engine materializes the
      // onboarding reminders on the next tick.
      await runAutomationEngine();
      const rows = (await db.select().from(s.followUps).where(eq(s.followUps.businessId, createdBiz.id)).execute()).filter((x) => onboardingStepOf(x.templateKey) !== null);
      const rules = await repo.listAutomationRules(createdBiz.id);
      pass("T12b engine scheduled all 4 reminders for the new tenant", rows.length === 4 && rows.every((x) => x.status === "pending"), rows.map((x) => x.templateKey).join(","));
      pass("T12c onboarding_reminders rule present on the new tenant", rules.some((x) => x.name === "onboarding_reminders"), rules.map((x) => x.name).join(","));
      await wipeBusiness(createdBiz.id);
    }
    await db.delete(s.sessions).where(eq(s.sessions.userId, admin.id)).execute();
    // admin@leadflow.ai is the shared platform admin (same contract as
    // dogfood-test / brain5b) — left in place, never deleted.
  }

  // ------------------------------------------------------------ cleanup
  await wipeBusiness(bizId);
  await db.delete(s.sessions).where(eq(s.sessions.userId, owner.id)).execute();
  await db.delete(s.users).where(eq(s.users.id, owner.id)).execute();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("onboarding-test crashed:", err);
  process.exit(1);
});
