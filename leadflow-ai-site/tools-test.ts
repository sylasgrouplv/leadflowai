/**
 * AI BRAIN 2 — FORMAL TOOL REGISTRY + 0–100 LEAD SCORING RUBRIC acceptance
 * test (spec §24–25 tool registry/permissions, §9–11 scoring, §31 error
 * handling, §33 tenant isolation).
 *
 * Runs the registry IN-PROCESS against the local SQLite DB (the server and
 * this process share .data/leadflow.db, same pattern as brain-test.ts's DB
 * assertions). Exercises:
 *
 *   (a) the registry lists every tool with the correct permission level,
 *   (b) an AI-initiated HIGH_RISK call is REJECTED + a human task is created
 *       + it is audit-logged,
 *   (c) score_lead produces correct scores/classifications for representative
 *       inputs (100 → HOT, 60 → WARM, 30 → COLD, outside area → UNQUALIFIED,
 *       complaint context → HUMAN_REVIEW),
 *   (d) a WRITE tool call for a foreign business's lead is rejected (tenant
 *       isolation),
 *   (e) every mutation writes an agent_actions row with success/failure,
 *   (f) §35 scenario behaviors still pass — run `bun run brain-test.ts`
 *       separately (it exercises the published site end-to-end).
 *
 * Run:  cd /home/team/shared/site && bun run tools-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { TOOL_REGISTRY, AI_ACCESSIBLE_TOOLS, callAiTool, ToolError } from "./src/server/ai/tools/registry";
import { computeLeadScore, classifyLeadScore, displayScoreFor } from "./src/server/ai/tools/score";

runMigrations();

const SOURCE = "tools_test";
let failures = 0;

function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// Setup: demo business (same seed as brain-test)
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
const bizId = business.id;
const DEMO_CTX = { businessId: bizId, agent: "test" };

const createdLeadIds: string[] = [];
async function newTestLead(over: Partial<{ firstName: string; location: string; serviceRequested: string }> = {}) {
  const lead = await repo.createLead({
    businessId: bizId,
    firstName: over.firstName ?? "Tools",
    lastName: "Test",
    source: SOURCE,
    serviceRequested: over.serviceRequested ?? "",
    location: over.location ?? "",
  });
  createdLeadIds.push(lead!.id);
  return lead!;
}

async function actionsFor(leadId: string) {
  const all = await repo.listAgentActions(bizId, 400);
  return all.filter((a) => a.leadId === leadId);
}
function resultOf(a: { resultJson: string | null }) {
  try {
    return JSON.parse(a.resultJson ?? "{}");
  } catch {
    return {};
  }
}

// ===========================================================================
// (a) Registry completeness + permission levels
// ===========================================================================
console.log("\n== (a) tool registry ==");

const expectedRead = ["get_business_info", "get_lead", "get_service", "check_calendar", "research_prospect"];
const expectedWrite = ["create_lead", "update_lead", "set_lead_status", "score_lead", "schedule_followup", "stop_followup", "opt_out", "book_appointment", "send_message", "send_followup", "send_review_request", "schedule_appointment_reminder", "schedule_onboarding_reminders", "categorize_human_task", "create_invoice", "schedule_invoice_reminder", "record_feedback", "create_human_task", "record_usage"];
const expectedHighRisk = ["cancel_appointment", "refund", "change_billing", "modify_sensitive_data"];

const readTools = TOOL_REGISTRY.filter((t) => t.permissionLevel === "READ").map((t) => t.name);
const writeTools = TOOL_REGISTRY.filter((t) => t.permissionLevel === "WRITE").map((t) => t.name);
const highRiskTools = TOOL_REGISTRY.filter((t) => t.permissionLevel === "HIGH_RISK").map((t) => t.name);

pass("registry has all READ tools", expectedRead.every((n) => readTools.includes(n)) && readTools.length === expectedRead.length, `READ=${readTools.join(",")}`);
pass("registry has all WRITE tools", expectedWrite.every((n) => writeTools.includes(n)) && writeTools.length === expectedWrite.length, `WRITE=${writeTools.join(",")}`);
pass("registry declares all HIGH_RISK tools", expectedHighRisk.every((n) => highRiskTools.includes(n)) && highRiskTools.length === expectedHighRisk.length, `HIGH_RISK=${highRiskTools.join(",")}`);
pass("every tool declares description/schema/validate/handler/audit",
  TOOL_REGISTRY.every((t) => t.description.length > 0 && !!t.inputSchema && typeof t.validate === "function" && typeof t.handler === "function" && t.audit === true),
  `count=${TOOL_REGISTRY.length}`);
pass("AI has NO HIGH_RISK tools (AI_ACCESSIBLE_TOOLS excludes them)",
  expectedHighRisk.every((n) => !AI_ACCESSIBLE_TOOLS.includes(n)) && AI_ACCESSIBLE_TOOLS.length === expectedRead.length + expectedWrite.length,
  `AI tools=${AI_ACCESSIBLE_TOOLS.length}`);

// ===========================================================================
// (b) HIGH_RISK attempt by AI → rejected + human task + audit
// ===========================================================================
console.log("\n== (b) HIGH_RISK permission enforcement ==");

{
  const lead = await newTestLead();
  let denied = false;
  let code = "";
  try {
    await callAiTool("cancel_appointment", { ...DEMO_CTX, leadId: lead.id }, { appointment_id: "00000000-0000-4000-8000-000000000000" });
  } catch (e) {
    denied = e instanceof ToolError;
    code = e instanceof ToolError ? e.code : String(e);
  }
  pass("AI cancel_appointment attempt is REJECTED", denied && code === "permission_denied", `code=${code}`);
  const acts = await actionsFor(lead.id);
  const deniedAudit = acts.filter((a) => a.action === "cancel_appointment").at(-1);
  const r = deniedAudit ? resultOf(deniedAudit) : {};
  pass("rejection is audit-logged (success=0, rejected=high-risk-forbidden)",
    !!deniedAudit && deniedAudit.success === 0 && r.rejected === true && r.reason === "high-risk-forbidden", `success=${deniedAudit?.success} result=${JSON.stringify(r)}`);
  const tasks = await repo.listHumanTasks(bizId, 50);
  const task = tasks.find((t) => t.leadId === lead.id && /cancel_appointment/.test(t.reason));
  pass("rejection created a human escalation task (priority/lead_id/reason/recommended_action)",
    !!task && task.priority === "high" && task.leadId === lead.id && !!task.recommendedAction && task.status === "open",
    `task=${task ? `${task.priority} ${task.reason.slice(0, 50)}` : "none"}`);
  // The lead row must be untouched — nothing was changed by the AI.
  const after = await repo.getLeadById(bizId, lead.id);
  pass("rejected call changed nothing on the lead", !!after && after.status === "new" && after.score === "cold", `status=${after?.status}`);
}

// ===========================================================================
// (c) score_lead — the 0–100 rubric (spec §9–11)
// ===========================================================================
console.log("\n== (c) score_lead rubric ==");

{
  // 100 → HOT: emergency(25) + exact(20) + inside(20) + ready(20) + ready(15)
  const lead = await newTestLead();
  const hot = (await callAiTool("score_lead", DEMO_CTX, {
    lead_id: lead.id, service: "AC Tune-Up", location: "Springfield",
    urgency: "emergency", purchase_intent: "ready", appointment_intent: "ready",
  })) as any;
  pass("score_lead 100 → HOT", hot.score === 100 && hot.classification === "HOT", `score=${hot.score} class=${hot.classification}`);

  // 60 → WARM: none(5) + exact(20) + inside(20) + strong(15) + none(0)
  const lead2 = await newTestLead();
  const warm = (await callAiTool("score_lead", DEMO_CTX, {
    lead_id: lead2.id, service: "AC Tune-Up", location: "Springfield",
    urgency: "none", purchase_intent: "strong", appointment_intent: "none",
  })) as any;
  pass("score_lead 60 → WARM", warm.score === 60 && warm.classification === "WARM", `score=${warm.score} class=${warm.classification}`);

  // 30 → COLD: none(5) + not offered(0) + unknown-location borderline(10) + strong(15) + none(0)
  const lead3 = await newTestLead();
  const cold = (await callAiTool("score_lead", DEMO_CTX, {
    lead_id: lead3.id, service: "Plumbing", location: "",
    urgency: "none", purchase_intent: "strong", appointment_intent: "none",
  })) as any;
  pass("score_lead 30 → COLD", cold.score === 30 && cold.classification === "COLD", `score=${cold.score} class=${cold.classification}`);

  // Outside service area → UNQUALIFIED regardless of other scores (even max).
  const lead4 = await newTestLead();
  const unq = (await callAiTool("score_lead", DEMO_CTX, {
    lead_id: lead4.id, service: "AC Tune-Up", location: "90210",
    urgency: "emergency", purchase_intent: "ready", appointment_intent: "ready",
  })) as any;
  pass("score_lead outside area → UNQUALIFIED", unq.classification === "UNQUALIFIED" && unq.score === 80, `score=${unq.score} class=${unq.classification}`);

  // Angry/complaint context → HUMAN_REVIEW regardless of score.
  const lead5 = await newTestLead();
  const hr = (await callAiTool("score_lead", DEMO_CTX, {
    lead_id: lead5.id, service: "AC Tune-Up", location: "Springfield",
    urgency: "urgent", purchase_intent: "ready", appointment_intent: "ready",
    escalation: "complaint: technician damaged my floor",
  })) as any;
  pass("score_lead complaint context → HUMAN_REVIEW", hr.classification === "HUMAN_REVIEW" && hr.score === 95, `score=${hr.score} class=${hr.classification}`);

  // Result shape: reasoning_summary + recommended_next_action + display badge.
  pass("score_lead returns reasoning + recommended action + display badge",
    typeof hot.reasoning_summary === "string" && hot.reasoning_summary.length > 0 &&
      typeof hot.recommended_next_action === "string" && hot.recommended_next_action.length > 0 &&
      hot.display_score === "hot" && warm.display_score === "warm" && cold.display_score === "cold" && unq.display_score === "cold" && hr.display_score === "hot",
    `display: ${hot.display_score},${warm.display_score},${cold.display_score},${unq.display_score},${hr.display_score}`);

  // Persistence: score_value + classification written to the lead row.
  const row = await repo.getLeadById(bizId, lead5.id);
  pass("score_lead persists score_value + classification", !!row && row.scoreValue === 95 && row.classification === "HUMAN_REVIEW", `score_value=${row?.scoreValue} class=${row?.classification}`);
  const acts = await actionsFor(lead5.id);
  const scoreAudit = acts.filter((a) => a.action === "score_lead").at(-1);
  pass("score_lead is audit-logged with success=1 + result", !!scoreAudit && scoreAudit.success === 1 && resultOf(scoreAudit).classification === "HUMAN_REVIEW", `success=${scoreAudit?.success}`);

  // Pure rubric sanity (unit-level).
  pass("classifyLeadScore boundaries (80/50)", classifyLeadScore(80) === "HOT" && classifyLeadScore(79) === "WARM" && classifyLeadScore(50) === "WARM" && classifyLeadScore(49) === "COLD", "");
  pass("displayScoreFor mapping", displayScoreFor("HOT") === "hot" && displayScoreFor("WARM") === "warm" && displayScoreFor("COLD") === "cold" && displayScoreFor("UNQUALIFIED") === "cold" && displayScoreFor("HUMAN_REVIEW") === "hot", "");
  const pure = computeLeadScore({ urgency: "urgent", serviceFit: "exact", locationFit: "inside", purchaseIntent: "researching", appointmentIntent: "considering" });
  pass("computeLeadScore 20+20+20+8+8 = 76 → WARM", pure.score === 76 && pure.classification === "WARM", `score=${pure.score}`);
}

// ===========================================================================
// (d) Tenant isolation — WRITE tool for a foreign business's lead is rejected
// ===========================================================================
console.log("\n== (d) tenant isolation ==");

let foreignUserId = "";
let foreignBizId = "";
let foreignLeadId = "";
{
  const user = await repo.createUser({ email: `tools-tenant-${Date.now()}@test.local`, passwordHash: "x", name: "Tenant Test" });
  foreignUserId = user!.id;
  const biz = await repo.createBusiness({ ownerId: user!.id, name: "Foreign HVAC Co", category: "hvac" });
  foreignBizId = biz!.id;
  const lead = await repo.createLead({ businessId: foreignBizId, firstName: "Foreign", lastName: "Lead", source: SOURCE });
  foreignLeadId = lead!.id;

  let denied = false;
  let code = "";
  try {
    await callAiTool("update_lead", DEMO_CTX, { lead_id: foreignLeadId, first_name: "Hacked" });
  } catch (e) {
    denied = e instanceof ToolError;
    code = e instanceof ToolError ? e.code : String(e);
  }
  pass("WRITE tool on foreign lead is REJECTED (tenant_mismatch)", denied && code === "tenant_mismatch", `code=${code}`);

  const all = await repo.listAgentActions(bizId, 400);
  const tenantAudit = all.filter((a) => a.action === "update_lead" && a.inputJson?.includes(foreignLeadId)).at(-1);
  const r = tenantAudit ? resultOf(tenantAudit) : {};
  pass("tenant rejection is audit-logged (success=0, rejected=true)", !!tenantAudit && tenantAudit.success === 0 && r.rejected === true, `success=${tenantAudit?.success} result=${JSON.stringify(r)}`);

  // The foreign lead must be untouched.
  const foreign = await repo.getLeadById(foreignBizId, foreignLeadId);
  pass("foreign lead unchanged", !!foreign && foreign.firstName === "Foreign", `firstName=${foreign?.firstName}`);

  // READ tools are scoped too.
  let readDenied = false;
  try {
    await callAiTool("get_lead", DEMO_CTX, { lead_id: foreignLeadId });
  } catch (e) {
    readDenied = e instanceof ToolError && (e as ToolError).code === "tenant_mismatch";
  }
  pass("READ tool on foreign lead is REJECTED", readDenied, "");
}

// ===========================================================================
// (e) Mutations write agent_actions rows with success/failure
// ===========================================================================
console.log("\n== (e) mutation audit trail ==");

{
  // create_lead via the tool → success audit row.
  const lead = (await callAiTool("create_lead", DEMO_CTX, {
    first_name: "Created", last_name: "ByTool", source: SOURCE, service_requested: "AC Repair", location: "Springfield",
  })) as any;
  createdLeadIds.push(lead.id);
  const acts = await actionsFor(lead.id);
  const createAudit = acts.filter((a) => a.action === "create_lead").at(-1);
  pass("create_lead audited (success=1)", !!createAudit && createAudit.success === 1, `agent=${createAudit?.agent}`);

  // Invalid input → audited failure without touching the DB.
  let invalid = false;
  try {
    await callAiTool("update_lead", DEMO_CTX, { lead_id: "not-a-uuid", first_name: "x" });
  } catch (e) {
    invalid = e instanceof ToolError && (e as ToolError).code === "invalid_input";
  }
  const all1 = await repo.listAgentActions(bizId, 400);
  const invalidAudit = all1.filter((a) => a.action === "update_lead" && a.resultJson?.includes("invalid-input")).at(-1);
  pass("invalid input → audited failure (success=0)", invalid && !!invalidAudit && invalidAudit.success === 0, `success=${invalidAudit?.success}`);

  // send_message (WRITE) → audited success.
  const conv = await repo.createConversation(bizId, { leadId: lead.id });
  const msg = (await callAiTool("send_message", DEMO_CTX, { conversation_id: conv!.id, body: "Hello from the registry" })) as any;
  const all2 = await repo.listAgentActions(bizId, 400);
  const msgAudit = all2.filter((a) => a.action === "send_message" && a.inputJson?.includes(conv!.id)).at(-1);
  pass("send_message audited (success=1)", !!msg && !!msgAudit && msgAudit.success === 1, `success=${msgAudit?.success}`);

  // set_lead_status (WRITE) → audited success.
  await callAiTool("set_lead_status", DEMO_CTX, { lead_id: lead.id, status: "contacted" });
  const all3 = await repo.listAgentActions(bizId, 400);
  const statusAudit = all3.filter((a) => a.action === "set_lead_status" && a.inputJson?.includes(lead.id)).at(-1);
  const statusRow = await repo.getLeadById(bizId, lead.id);
  pass("set_lead_status audited + applied", !!statusAudit && statusAudit.success === 1 && statusRow?.status === "contacted", `status=${statusRow?.status}`);

  // schedule_followup (WRITE) → audited success (config default 1/3/7/14).
  const fup = (await callAiTool("schedule_followup", DEMO_CTX, { lead_id: lead.id })) as any;
  const all4 = await repo.listAgentActions(bizId, 400);
  const fupAudit = all4.filter((a) => a.action === "schedule_followup" && a.inputJson?.includes(lead.id)).at(-1);
  pass("schedule_followup audited", !!fupAudit && fupAudit.success === 1 && (fup.started === true || fup.reason === "already-scheduled"), `success=${fupAudit?.success} started=${fup.started} reason=${fup.reason}`);

  // opt_out (WRITE) → audited success + lead opted out + follow-ups cancelled.
  await callAiTool("opt_out", DEMO_CTX, { lead_id: lead.id, channel: "all" });
  const all5 = await repo.listAgentActions(bizId, 400);
  const optAudit = all5.filter((a) => a.action === "opt_out" && a.inputJson?.includes(lead.id)).at(-1);
  const opted = await repo.getLeadById(bizId, lead.id);
  pass("opt_out audited + applied", !!optAudit && optAudit.success === 1 && opted?.optedOut === 1, `optedOut=${opted?.optedOut}`);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log(failures === 0 ? "\nTOOLS-TEST: ALL PASS" : `\nTOOLS-TEST: ${failures} FAILURE(S)`);

// ---------------------------------------------------------------------------
// Cleanup — remove every row this test created (demo DB stays clean).
// ---------------------------------------------------------------------------
try {
  const db = (await import("./src/server/db/client")).getDb();
  const s = await import("./src/server/db/schema");
  const { eq } = await import("drizzle-orm");
  const leads = db.select().from(s.leads).where(eq(s.leads.businessId, bizId)).all().filter((l) => l.source === SOURCE || createdLeadIds.includes(l.id));
  for (const l of leads) {
    for (const c of db.select().from(s.conversations).where(eq(s.conversations.leadId, l.id)).all()) {
      db.delete(s.messages).where(eq(s.messages.conversationId, c.id)).run();
      db.delete(s.conversations).where(eq(s.conversations.id, c.id)).run();
    }
    db.delete(s.followUps).where(eq(s.followUps.leadId, l.id)).run();
    db.delete(s.appointments).where(eq(s.appointments.leadId, l.id)).run();
    db.delete(s.humanTasks).where(eq(s.humanTasks.leadId, l.id)).run();
    db.delete(s.agentActions).where(eq(s.agentActions.leadId, l.id)).run();
    db.delete(s.leads).where(eq(s.leads.id, l.id)).run();
  }
  if (foreignBizId) {
    db.delete(s.leads).where(eq(s.leads.businessId, foreignBizId)).run();
    db.delete(s.businesses).where(eq(s.businesses.id, foreignBizId)).run();
  }
  if (foreignUserId) db.delete(s.users).where(eq(s.users.id, foreignUserId)).run();
  // Notifications created by human-task records (escalation kind, body matches).
  const notifs = db.select().from(s.notifications).where(eq(s.notifications.businessId, bizId)).all();
  for (const n of notifs) {
    if (n.kind === "escalation" && /Human task|Needs human attention/.test(n.title) && /HIGH_RISK|AI tool|human task/.test(n.body + n.title)) {
      db.delete(s.notifications).where(eq(s.notifications.id, n.id)).run();
    }
  }
  console.log(`cleanup done (${leads.length} test leads removed)`);
} catch (e) {
  console.error("cleanup error:", e);
}
process.exit(failures === 0 ? 0 : 1);
