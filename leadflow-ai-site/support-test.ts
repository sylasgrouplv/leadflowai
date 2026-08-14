/**
 * PHASE 2 / CHUNK F acceptance — SUPPORT TICKET CATEGORIZATION
 * (dogfooding automation #7).
 *
 * Exercises:
 *   T1  the support_ticket_categorization default rule is wired
 *       (HUMAN_ESCALATION → categorize_human_task, delay 0, condition none)
 *   T2  classifyTaskCategory unit cases (each category + field concat)
 *   T3  precedence: emergency > billing > complaint > technical > other
 *       (+ empty text → other)
 *   T4  categorize_human_task WRITE tool: categorizes a real task, notifies
 *       the owner (kind support_ticket_categorized), writes an audit row
 *   T5  tool validation: foreign-business task and unknown task are REJECTED
 *       (tenant_mismatch)
 *   T6  end-to-end: HUMAN_ESCALATION event → engine run → task categorized +
 *       owner notified; the run payload carried the taskId from the event
 *
 * Style: matches onboarding-test.ts (in-process suites) — repo functions +
 * the automation engine + the Hono app, local SQLite, tenant-scoped cleanup.
 * HTTP-free.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run support-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { eq } from "drizzle-orm";
import { runAutomationEngine } from "./src/server/automations/engine";
import { ensureDogfoodRules } from "./scripts/seed-dogfood";
import { callAiTool, createHumanTaskRecord, ToolError } from "./src/server/ai/tools/registry";
import {
  classifyTaskCategory,
  EMERGENCY_WORDS,
  BILLING_WORDS,
  COMPLAINT_WORDS,
  TECHNICAL_WORDS,
} from "./src/server/support/agent";
runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();
/** Same tenant-scoped cleanup as reminder-test / onboarding-test (FK-safe). */
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
(async () => {
  // ------------------------------------------------------------ setup tenant
  const stamp = Date.now();
  const owner = await repo.createUser({
    name: "Support Test Owner",
    email: `support-owner-${stamp}@test.local`,
    passwordHash: "$2b$10$test", // unused — no auth exercised
    role: "owner",
  });
  const business = await repo.createBusiness({ ownerId: owner.id, name: "Support Test Co", category: "home_services", phone: "(517) 555-3000" });
  const bizId = business.id;
  // ------------------------------------------------------------ T1 rule
  await ensureDogfoodRules(bizId); // the dogfood seed path (7 default rules)
  const rules = await repo.listAutomationRules(bizId);
  const catRule = rules.find((r) => r.name === "support_ticket_categorization");
  pass(
    "T1 support_ticket_categorization default rule wired",
    !!catRule && catRule.triggerEvent === "HUMAN_ESCALATION" && catRule.action === "categorize_human_task" && catRule.conditionJson.includes("none") && catRule.delayMs === 0,
    catRule ? `${catRule.triggerEvent}→${catRule.action} delay=${catRule.delayMs}` : "missing"
  );
  pass("T1b eight default rules (dogfood)", rules.length === 8, `n=${rules.length}`);
  // ------------------------------------------------------------ T2 classifier
  console.log("\n== classifier unit cases ==");
  pass("T2a billing", classifyTaskCategory("Customer is disputing the amount on their invoice and wants a refund") === "billing", "");
  pass("T2b technical", classifyTaskCategory("The chat widget won't load on the website — getting an error") === "technical", "");
  pass("T2c emergency", classifyTaskCategory("Emergency! The furnace burst and there is water everywhere, no heat") === "emergency", "");
  pass("T2d complaint", classifyTaskCategory("Customer was very upset, said the technician was rude and the work was unacceptable") === "complaint", "");
  pass("T2e other", classifyTaskCategory("Just a general question about your business hours") === "other", "");
  pass("T2f category from conversationSummary field", classifyTaskCategory("needs human review", "customer asked about the fee on their bill", "") === "billing", "");
  pass("T2g category from recommendedAction field", classifyTaskCategory("needs human review", "", "reconnect the widget integration and check the API logs") === "technical", "");
  // ------------------------------------------------------------ T3 precedence
  console.log("\n== precedence ==");
  pass("T3a emergency beats complaint", classifyTaskCategory("Customer is angry about the burst pipe — emergency") === "emergency", "");
  pass("T3b billing beats complaint", classifyTaskCategory("Customer complained they were overcharged on the invoice") === "billing", "");
  pass("T3c complaint beats technical", classifyTaskCategory("Furious that the widget is broken and it's unacceptable") === "complaint", "");
  pass("T3d empty text → other", classifyTaskCategory("", "", "") === "other", "");
  pass("T3e keyword sets exported + non-empty", EMERGENCY_WORDS.length > 0 && BILLING_WORDS.length > 0 && COMPLAINT_WORDS.length > 0 && TECHNICAL_WORDS.length > 0, "");
  // ------------------------------------------------------------ T4 tool handler
  console.log("\n== categorize_human_task tool ==");
  const lead = await repo.createLead({ businessId: bizId, firstName: "Support", lastName: "Test", source: "support_test", serviceRequested: "" });
  const task = await repo.createHumanTask({
    businessId: bizId,
    leadId: lead.id,
    priority: "high",
    reason: "Customer was charged twice on their credit card",
    conversationSummary: "Billing dispute about the invoice",
    recommendedAction: "Review the charges and issue a refund",
  });
  const res = (await callAiTool("categorize_human_task", { businessId: bizId, agent: "test" }, { human_task_id: task.id })) as { humanTaskId: string; category: string };
  const reread = await repo.getHumanTaskById(bizId, task.id);
  pass("T4 tool categorizes a real task (billing)", res.humanTaskId === task.id && res.category === "billing" && reread?.category === "billing", JSON.stringify(res));
  const notifs = await repo.listNotifications(bizId, 50);
  pass(
    "T4b owner notified with category (kind support_ticket_categorized)",
    notifs.some((n) => n.kind === "support_ticket_categorized" && n.title.includes("billing") && n.body.includes("charged twice")),
    notifs.map((n) => `${n.kind}:${n.title}`).join(" | ")
  );
  const acts = await repo.listAgentActions(bizId, 400);
  pass("T4c audit row written (categorize_human_task success)", acts.some((a) => a.action === "categorize_human_task" && a.success === 1), acts.map((a) => a.action).join(","));
  // ------------------------------------------------------------ T5 validation
  console.log("\n== tenant isolation ==");
  const owner2 = await repo.createUser({ name: "Support Other Owner", email: `support-other-${stamp}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
  const biz2 = await repo.createBusiness({ ownerId: owner2.id, name: "Other Support Co", category: "home_services", phone: "(517) 555-4000" });
  let denied = false;
  let code = "";
  try {
    await callAiTool("categorize_human_task", { businessId: biz2.id, agent: "test" }, { human_task_id: task.id });
  } catch (e) {
    denied = e instanceof ToolError;
    code = e instanceof ToolError ? e.code : String(e);
  }
  pass("T5 foreign-business task REJECTED (tenant_mismatch)", denied && code === "tenant_mismatch", `code=${code}`);
  denied = false;
  code = "";
  try {
    await callAiTool("categorize_human_task", { businessId: bizId, agent: "test" }, { human_task_id: "00000000-0000-4000-8000-000000000000" });
  } catch (e) {
    denied = e instanceof ToolError;
    code = e instanceof ToolError ? e.code : String(e);
  }
  pass("T5b unknown task REJECTED (tenant_mismatch)", denied && code === "tenant_mismatch", `code=${code}`);
  // ------------------------------------------------------------ T6 rule e2e
  console.log("\n== HUMAN_ESCALATION → rule → categorize + notify (end-to-end) ==");
  const lead2 = await repo.createLead({ businessId: bizId, firstName: "Urgent", lastName: "Case", source: "support_test", serviceRequested: "" });
  const task2 = await createHumanTaskRecord(bizId, {
    leadId: lead2.id,
    priority: "urgent",
    reason: "Emergency — water leak flooding the basement right now, no heat",
    conversationSummary: "Customer has water everywhere and can't wait",
    recommendedAction: "Call the customer immediately",
  });
  // createHumanTaskRecord emitted HUMAN_ESCALATION with { taskId, priority, reason };
  // the engine materializes + executes the run.
  const summary = await runAutomationEngine();
  const task2r = await repo.getHumanTaskById(bizId, task2.id);
  pass("T6 HUMAN_ESCALATION → rule → task categorized (emergency)", task2r?.category === "emergency", `category=${task2r?.category}`);
  const notifs2 = await repo.listNotifications(bizId, 50);
  pass(
    "T6b owner notified via rule (kind support_ticket_categorized, emergency)",
    notifs2.some((n) => n.kind === "support_ticket_categorized" && n.title.includes("emergency")),
    notifs2.map((n) => `${n.kind}:${n.title}`).join(" | ")
  );
  const runs = await db.select().from(s.automationRuns).where(eq(s.automationRuns.businessId, bizId)).execute();
  const catRun = runs.find((r) => r.ruleKind === "support_ticket_categorization");
  pass("T6c run executed (done)", catRun?.status === "done", `status=${catRun?.status}`);
  const payload = catRun ? (JSON.parse(catRun.payloadJson || "{}") as Record<string, unknown>) : {};
  pass("T6d run payload carried taskId from the event", payload.taskId === task2.id, `taskId=${String(payload.taskId)}`);
  pass("T6e engine summary executed >= 1 run", summary.executed >= 1, `executed=${summary.executed}`);
  // ------------------------------------------------------------ cleanup
  await wipeBusiness(bizId);
  await db.delete(s.sessions).where(eq(s.sessions.userId, owner.id)).execute();
  await db.delete(s.users).where(eq(s.users.id, owner.id)).execute();
  await wipeBusiness(biz2.id);
  await db.delete(s.sessions).where(eq(s.sessions.userId, owner2.id)).execute();
  await db.delete(s.users).where(eq(s.users.id, owner2.id)).execute();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("support-test crashed:", err);
  process.exit(1);
});
