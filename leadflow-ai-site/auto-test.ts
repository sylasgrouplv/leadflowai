/**
 * AI BRAIN 3 — EVENT SYSTEM + AUTOMATION ENGINE acceptance test
 * (spec §29 automation engine, §30 event system, §31 error handling).
 *
 * Runs IN-PROCESS against the local SQLite DB (same pattern as tools-test.ts:
 * the server and this process share .data/leadflow.db). Exercises:
 *
 *   (a) events are emitted on: lead create, message received + appointment
 *       requested (chat), qualified, appointment booked / cancelled, job
 *       completed, opt-out, human escalation — each carrying business_id
 *       (tenant isolation) + lead/conversation ids + payload + timestamp,
 *   (b) an event-triggered + conditional + delayed rule executes end-to-end:
 *       create rule → event → run rows materialized → force run_at into the
 *       past → worker fires → action created + audit-logged + run done;
 *       a failing condition cancels the run instead of executing,
 *   (c) a stopped/cancelled run does NOT fire (explicit cancel + follow-up
 *       stop rule),
 *   (d) a failing action retries with backoff, records last_error/attempts,
 *       then fails; critical failures create a human task (§31),
 *   (e) the follow-up sequence + stop rules still work — through the engine:
 *       qualified → rule → schedule step 1 → run fires → SMS sent (mock) →
 *       step 2 scheduled; booking an appointment cancels pending rows + runs,
 *   (f) runs persist across a "restart": runs live in the DB; a delayed run
 *       stays pending across engine passes and fires when due.
 *
 * Run:  cd /home/team/shared/site && bun run auto-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { callAiTool } from "./src/server/ai/tools/registry";
import { emitEvent, eventEmitted, listEvents } from "./src/server/ai/events";
import { runAutomationEngine } from "./src/server/automations/engine";
import { handleLeadMessage } from "./src/server/ai/engine";
import { checkCalendarAction, updateAppointmentStatusAction } from "./src/server/appointments/agent";
import type { EventType } from "./src/server/db/schema";

runMigrations();

const SOURCE = "auto_test";
const START_TS = Date.now();
const DEMO_CTX = { businessId: "", agent: "auto-test" };
let failures = 0;

function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}

async function eventsSince(type?: EventType, leadId?: string): Promise<boolean> {
  return eventEmitted(DEMO_CTX.businessId, type!, START_TS, leadId);
}

// ---------------------------------------------------------------------------
// Setup: demo business (same seed as brain-test / tools-test)
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
DEMO_CTX.businessId = business.id;
const bizId = business.id;

const createdLeadIds: string[] = [];
const createdRuleIds: string[] = [];
const createdRunIds: string[] = [];

async function newTestLead(over: Partial<{ firstName: string; phone: string; email: string; serviceRequested: string; location: string }> = {}) {
  const lead = (await callAiTool("create_lead", DEMO_CTX, {
    first_name: over.firstName ?? "Auto",
    last_name: "Test",
    phone: over.phone ?? "",
    email: over.email ?? "",
    source: SOURCE,
    service_requested: over.serviceRequested ?? "",
    location: over.location ?? "",
  })) as Awaited<ReturnType<typeof repo.createLead>>;
  if (!lead) throw new Error("could not create lead");
  createdLeadIds.push(lead.id);
  return lead;
}

async function scoreHot(leadId: string) {
  await callAiTool("score_lead", DEMO_CTX, {
    lead_id: leadId,
    service: "AC Tune-Up",
    location: "Springfield",
    urgency: "emergency",
    purchase_intent: "ready",
    appointment_intent: "ready",
  });
}

async function qualify(leadId: string) {
  await callAiTool("set_lead_status", DEMO_CTX, { lead_id: leadId, status: "qualified" });
}

async function forceDue(runId: string) {
  await repo.updateAutomationRun(bizId, runId, { runAt: Date.now() - 5_000 });
}

async function findRun(pred: (r: Awaited<ReturnType<typeof repo.listAutomationRuns>>[number]) => boolean) {
  return (await repo.listAutomationRuns(bizId, 400)).find(pred) ?? null;
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

/** Parse an automation run's payload JSON. */
function payloadOf(r: { payloadJson: string | null }) {
  try {
    return JSON.parse(r.payloadJson ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ===========================================================================
// (a) Events on the full event set
// ===========================================================================
console.log("\n== (a) event bus ==");

{
  // LEAD_CREATED via the registry tool.
  const lead = await newTestLead({ firstName: "EventLead" });
  pass("LEAD_CREATED emitted (business_id + lead_id)", await eventsSince("LEAD_CREATED", lead.id), "");
  const evs = await listEvents(bizId, 400);
  const created = evs.find((e) => e.type === "LEAD_CREATED" && e.leadId === lead.id);
  pass("event carries type/business_id/lead_id/payload/timestamp",
    !!created && created.businessId === bizId && typeof created.payload === "object" && created.createdAt >= START_TS, `payload=${JSON.stringify(created?.payload ?? {}).slice(0, 80)}`);
}

// MESSAGE_RECEIVED + APPOINTMENT_REQUESTED + MESSAGE_SENT via the real chat path.
{
  const lead = await newTestLead({ firstName: "Chatty" });
  const conv = await repo.createConversation(bizId, { leadId: lead.id });
  const bundle = await handleLeadMessage(bizId, conv!.id, "Can someone come tomorrow afternoon?");
  pass("MESSAGE_RECEIVED emitted", await eventsSince("MESSAGE_RECEIVED", lead.id), "");
  pass("APPOINTMENT_REQUESTED emitted", await eventsSince("APPOINTMENT_REQUESTED", lead.id), "");
  pass("MESSAGE_SENT emitted (AI reply)", await eventsSince("MESSAGE_SENT", lead.id), "");
  pass("chat still returns an AI reply", bundle.messages.some((m) => m.sender === "ai"), `msgs=${bundle.messages.length}`);
}

// LEAD_QUALIFIED via the status choke point.
{
  const lead = await newTestLead({ firstName: "Qualified" });
  await scoreHot(lead.id);
  await qualify(lead.id);
  pass("LEAD_QUALIFIED emitted", await eventsSince("LEAD_QUALIFIED", lead.id), "");
}

// APPOINTMENT_BOOKED / CANCELLED / JOB_COMPLETED.
{
  const lead = await newTestLead({ firstName: "Booker", phone: "555-0101", email: "booker@example.com" });
  const services = await repo.listServices(bizId);
  const service = services.find((s) => s.name === "AC Tune-Up") ?? services[0];
  const days = await checkCalendarAction(bizId, { serviceId: service.id, days: 14 });
  const slots = days.flatMap((d) => d.slots);
  const future = slots.filter((s) => s.startAt > Date.now() + 60_000);
  pass("calendar has future slots for booking", future.length > 0, `slots=${future.length}`);
  if (future.length) {
    const booked = (await callAiTool("book_appointment", DEMO_CTX, {
      lead_id: lead.id, service_id: service.id, start_at: future[0].startAt,
    })) as { appointment: { id: string } };
    pass("APPOINTMENT_BOOKED emitted", await eventsSince("APPOINTMENT_BOOKED", lead.id), "");
    await updateAppointmentStatusAction(bizId, { appointmentId: booked.appointment.id, status: "cancelled" });
    pass("APPOINTMENT_CANCELLED emitted", await eventsSince("APPOINTMENT_CANCELLED", lead.id), "");

    // Second booking → complete → JOB_COMPLETED.
    const future2 = slots.filter((s) => s.startAt > Date.now() + 60_000);
    if (future2.length) {
      const booked2 = (await callAiTool("book_appointment", DEMO_CTX, {
        lead_id: lead.id, service_id: service.id, start_at: future2[0].startAt,
      })) as { appointment: { id: string } };
      await updateAppointmentStatusAction(bizId, { appointmentId: booked2.appointment.id, status: "completed" });
      pass("JOB_COMPLETED emitted", await eventsSince("JOB_COMPLETED", lead.id), "");
    } else {
      pass("JOB_COMPLETED emitted", false, "no second future slot");
    }
  }
}

// CUSTOMER_OPTED_OUT via the opt-out choke point.
{
  const lead = await newTestLead({ firstName: "OptOut" });
  await callAiTool("opt_out", DEMO_CTX, { lead_id: lead.id, channel: "all" });
  pass("CUSTOMER_OPTED_OUT emitted", await eventsSince("CUSTOMER_OPTED_OUT", lead.id), "");
  const opted = await repo.getLeadById(bizId, lead.id);
  pass("lead marked opted out", opted?.optedOut === 1, `optedOut=${opted?.optedOut}`);
}

// HUMAN_ESCALATION via the escalation choke point.
{
  const lead = await newTestLead({ firstName: "Escalate" });
  await callAiTool("create_human_task", DEMO_CTX, { lead_id: lead.id, priority: "high", reason: "auto-test escalation" });
  pass("HUMAN_ESCALATION emitted", await eventsSince("HUMAN_ESCALATION", lead.id), "");
  const tasks = await repo.listHumanTasks(bizId, 100);
  pass("escalation task created", tasks.some((t) => t.leadId === lead.id && /auto-test escalation/.test(t.reason)), "");
}

// Direct emit + event log observable.
{
  const lead = await newTestLead({ firstName: "Direct" });
  const ev = await emitEvent({ type: "REVIEW_REQUESTED", businessId: bizId, leadId: lead.id, payload: { from: "auto-test" } });
  pass("REVIEW_REQUESTED emittable (Review agent = Brain 4)", !!ev.id, "");
  const evs = await listEvents(bizId, 400);
  pass("event log is observable (listEvents returns events)", evs.length > 0, `count=${evs.length}`);
}

// ===========================================================================
// (b) event-triggered + conditional + delayed rule end-to-end
// ===========================================================================
console.log("\n== (b) event-triggered + conditional + delayed rule ==");

{
  // Conditional rule: score >= 50 → create a human task.
  const rule = await repo.createAutomationRule(bizId, {
    name: "auto_test_conditional",
    triggerEvent: "LEAD_QUALIFIED",
    condition: { type: "score_gte", value: 50 },
    action: "create_human_task",
    actionConfig: { priority: "high", reason: "auto-test conditional task" },
  });
  createdRuleIds.push(rule!.id);

  // Delayed rule: LEAD_CREATED → send_message-ish marker (create_human_task)
  // after 1h — proves delay + persistence.
  const delayed = await repo.createAutomationRule(bizId, {
    name: "auto_test_delayed",
    triggerEvent: "LEAD_CREATED",
    delayMs: 3_600_000,
    condition: { type: "none" },
    action: "create_human_task",
    actionConfig: { priority: "medium", reason: "auto-test delayed task" },
  });
  createdRuleIds.push(delayed!.id);

  // 1) Lead with score 100 (>= 50): qualified → run materialized immediately.
  const hot = await newTestLead({ firstName: "CondHot" });
  await scoreHot(hot.id);
  await qualify(hot.id);
  const run = await findRun((r) => r.ruleId === rule!.id && r.leadId === hot.id);
  pass("rule run materialized on event (status pending, payload has event)",
    !!run && run.status === "pending" && payloadOf(run).event === "LEAD_QUALIFIED", `run=${run?.id?.slice(0, 8)}`);

  // 2) Delayed rule: run_at is in the future — the worker must NOT fire it.
  const dRun = await findRun((r) => r.ruleId === delayed!.id && r.leadId === hot.id);
  pass("delayed rule run scheduled in the future", !!dRun && dRun.runAt > Date.now(), `runAt=${dRun?.runAt}`);
  if (dRun) {
    await runAutomationEngine();
    const still = await repo.getAutomationRunById(bizId, dRun.id);
    pass("delayed run not fired before its time", still?.status === "pending", `status=${still?.status}`);
    // 3) Force it due → worker fires → action executed + audited + done.
    await forceDue(dRun.id);
    await runAutomationEngine();
    const fired = await repo.getAutomationRunById(bizId, dRun.id);
    const tasks = await repo.listHumanTasks(bizId, 200);
    pass("delayed run fires when due (done)", fired?.status === "done", `status=${fired?.status}`);
    pass("delayed action executed (human task created)", tasks.some((t) => t.leadId === hot.id && /auto-test delayed task/.test(t.reason)), "");
    const acts = await actionsFor(hot.id);
    pass("action audit-logged via tool registry (create_human_task success)",
      acts.some((a) => a.action === "create_human_task" && a.success === 1 && typeof (resultOf(a) as { id?: unknown }).id === "string"), "");
  }

  // 4) Conditional run fires for the hot lead.
  await forceDue(run!.id);
  await runAutomationEngine();
  const done = await repo.getAutomationRunById(bizId, run!.id);
  pass("conditional run fires when condition holds (done)", done?.status === "done", `status=${done?.status}`);
  const tasks2 = await repo.listHumanTasks(bizId, 200);
  pass("conditional action executed (human task created)", tasks2.some((t) => t.leadId === hot.id && /auto-test conditional task/.test(t.reason)), "");

  // 5) Same rule, low-score lead (0 < 50): run fires but the CONDITION fails at
  //    fire time → cancelled, nothing executed.
  const cold = await newTestLead({ firstName: "CondCold" });
  await qualify(cold.id);
  const coldRun = await findRun((r) => r.ruleId === rule!.id && r.leadId === cold.id);
  pass("low-score lead gets a run too", !!coldRun, "");
  if (coldRun) {
    await forceDue(coldRun.id);
    await runAutomationEngine();
    const cancelled = await repo.getAutomationRunById(bizId, coldRun.id);
    pass("condition evaluated AT FIRE TIME — run cancelled, no action",
      cancelled?.status === "cancelled" && /condition:/.test(cancelled?.lastError ?? ""), `status=${cancelled?.status} err=${cancelled?.lastError}`);
    const coldActs = await actionsFor(cold.id);
    pass("no action executed for failed condition", !coldActs.some((a) => a.action === "create_human_task"), "");
  }
}

// ===========================================================================
// (c) stopped/cancelled runs do NOT fire
// ===========================================================================
console.log("\n== (c) cancelled/stopped runs do not fire ==");

{
  // Explicitly cancelled run.
  const lead = await newTestLead({ firstName: "CancelRun" });
  const run = await repo.createAutomationRun({
    businessId: bizId, leadId: lead.id, ruleKind: "create_human_task", runAt: Date.now() - 1_000,
    payload: { priority: "medium", reason: "cancelled-run-test" },
  });
  createdRunIds.push(run!.id);
  await repo.updateAutomationRun(bizId, run!.id, { status: "cancelled" });
  await runAutomationEngine();
  const after = await repo.getAutomationRunById(bizId, run!.id);
  pass("explicitly cancelled run stays cancelled (never fires)", after?.status === "cancelled", `status=${after?.status}`);
  const tasks = await repo.listHumanTasks(bizId, 200);
  pass("no action executed for cancelled run", !tasks.some((t) => t.leadId === lead.id && /cancelled-run-test/.test(t.reason)), "");

  // Follow-up stop rule: a run whose follow_up row was cancelled is cancelled
  // by the engine at fire time (no send).
  const lead2 = await newTestLead({ firstName: "StopRule", phone: "555-0102", email: "stop@example.com" });
  const followUpId = await repo.createFollowUp(bizId, { leadId: lead2.id, type: "sms", scheduledFor: Date.now() - 1_000, templateKey: "seq_1" });
  const stepRun = await repo.createAutomationRun({
    businessId: bizId, leadId: lead2.id, ruleKind: "followup_step_send", runAt: Date.now() - 1_000,
    payload: { followUpId, step: 1, templateKey: "seq_1", type: "sms" },
  });
  createdRunIds.push(stepRun!.id);
  await repo.cancelFollowUpsForLead(bizId, lead2.id); // stop rule
  await runAutomationEngine();
  const stepAfter = await repo.getAutomationRunById(bizId, stepRun!.id);
  const rowAfter = await repo.getFollowUpById(bizId, followUpId);
  pass("follow-up run cancelled when row stopped (never sends)", stepAfter?.status === "cancelled", `status=${stepAfter?.status}`);
  pass("stopped row stays cancelled", rowAfter?.status === "cancelled", `status=${rowAfter?.status}`);
}

// ===========================================================================
// (d) failing action → retry → failure; critical failure → human task
// ===========================================================================
console.log("\n== (d) error handling (§31) ==");

{
  const rule = await repo.createAutomationRule(bizId, {
    name: "auto_test_failing",
    triggerEvent: "LEAD_QUALIFIED",
    condition: { type: "none" },
    action: "send_followup",
    actionConfig: { followUpId: "00000000-0000-4000-8000-000000000000" }, // no such row
  });
  createdRuleIds.push(rule!.id);
  const lead = await newTestLead({ firstName: "Fails" });
  await qualify(lead.id);
  const run = await findRun((r) => r.ruleId === rule!.id && r.leadId === lead.id);
  pass("failing-action run materialized", !!run, "");

  // Attempt 1 → error → retried (pending, attempts=1, last_error set).
  await forceDue(run!.id);
  await runAutomationEngine();
  const r1 = await repo.getAutomationRunById(bizId, run!.id);
  pass("attempt 1 fails → retried (pending, attempts=1)", r1?.status === "pending" && r1?.attempts === 1 && (r1?.lastError ?? "").length > 0, `status=${r1?.status} attempts=${r1?.attempts} err=${(r1?.lastError ?? "").slice(0, 60)}`);
  const errLogs = (await repo.listAgentActions(bizId, 400)).filter((a) => a.action === "run_error" && a.inputJson?.includes(run!.id));
  pass("failure logged (agent/action/lead/error/retry_count — never silent)", errLogs.length === 1 && errLogs[0].success === 0, `logs=${errLogs.length}`);

  // Attempt 2 → still failing → retried.
  await forceDue(run!.id);
  await runAutomationEngine();
  const r2 = await repo.getAutomationRunById(bizId, run!.id);
  pass("attempt 2 fails → retried (attempts=2)", r2?.status === "pending" && r2?.attempts === 2, `attempts=${r2?.attempts}`);

  // Attempt 3 → exhausted → failed + human task (send_followup is critical).
  await forceDue(run!.id);
  await runAutomationEngine();
  const r3 = await repo.getAutomationRunById(bizId, run!.id);
  pass("attempt 3 exhausted → failed (attempts=3, last_error recorded)", r3?.status === "failed" && r3?.attempts === 3 && (r3?.lastError ?? "").length > 0, `status=${r3?.status} attempts=${r3?.attempts}`);
  const tasks = await repo.listHumanTasks(bizId, 300);
  const task = tasks.find((t) => t.leadId === lead.id && /Automation action 'send_followup' failed/.test(t.reason));
  pass("critical failure created a human task (§31)", !!task && task.priority === "high" && task.status === "open", `task=${task?.reason?.slice(0, 70)}`);
}

// ===========================================================================
// (e) follow-up sequence + stop rules work THROUGH the engine
// ===========================================================================
console.log("\n== (e) follow-up sequence through the engine ==");

{
  const lead = await newTestLead({ firstName: "Seq", phone: "555-0103", email: "seq@example.com", serviceRequested: "AC Repair" });
  await scoreHot(lead.id);
  await qualify(lead.id); // LEAD_QUALIFIED → default rule → run

  // Engine pass: the qualified rule fires → schedule_followup → step 1 + run.
  await runAutomationEngine();
  const seq1 = (await repo.listFollowUpsWithLead(bizId, 500)).find((f) => f.followUp.leadId === lead.id && f.followUp.templateKey === "seq_1");
  pass("qualified → engine → sequence step 1 scheduled (row + run)",
    !!seq1 && seq1.followUp.status === "pending" && (await repo.getRunForFollowUp(seq1.followUp.id)) !== null, `row=${seq1?.followUp.status}`);

  // Fire step 1: engine → send_followup tool → SMS sent + step 2 scheduled.
  const run1 = (await repo.getRunForFollowUp(seq1!.followUp.id))!;
  await forceDue(run1.id);
  await runAutomationEngine();
  const sent = await repo.getFollowUpById(bizId, seq1!.followUp.id);
  const seq2 = (await repo.listFollowUpsWithLead(bizId, 500)).find((f) => f.followUp.leadId === lead.id && f.followUp.templateKey === "seq_2");
  pass("step 1 fired → row sent", sent?.status === "sent", `status=${sent?.status}`);
  pass("FOLLOWUP_SENT event emitted", await eventsSince("FOLLOWUP_SENT", lead.id), "");
  pass("step 2 scheduled (row + run)", !!seq2 && seq2.followUp.status === "pending" && (await repo.getRunForFollowUp(seq2.followUp.id)) !== null, `status=${seq2?.followUp.status}`);
  const acts = await actionsFor(lead.id);
  pass("send audited through the registry (send_sms success)", acts.some((a) => a.action === "send_sms" && a.success === 1), "");

  // Stop rule: booking cancels pending follow-ups + runs (engine path).
  const services = await repo.listServices(bizId);
  const service = services.find((s) => s.name === "AC Tune-Up") ?? services[0];
  const days = await checkCalendarAction(bizId, { serviceId: service.id, days: 14 });
  const future = days.flatMap((d) => d.slots).filter((s) => s.startAt > Date.now() + 60_000);
  if (future.length) {
    const booked = (await callAiTool("book_appointment", DEMO_CTX, { lead_id: lead.id, service_id: service.id, start_at: future[0].startAt })) as { appointment: { id: string } };
    pass("booking succeeds", !!booked.appointment.id, "");
    const seq2row = await repo.getFollowUpById(bizId, seq2!.followUp.id);
    const run2 = await repo.getRunForFollowUp(seq2!.followUp.id);
    pass("pending step 2 cancelled by stop rule", seq2row?.status === "cancelled", `status=${seq2row?.status}`);
    pass("step-2 run cancelled (never fires)", run2?.status === "cancelled", `status=${run2?.status}`);
    // Engine pass with the run forced due: it must NOT send (cancelled row).
    if (run2) {
      await forceDue(run2.id);
      await runAutomationEngine();
      const after = await repo.getAutomationRunById(bizId, run2.id);
      pass("stopped run does not send", after?.status === "cancelled", `status=${after?.status}`);
      const sent2 = await repo.getFollowUpById(bizId, seq2!.followUp.id);
      pass("stopped follow-up row not sent", sent2?.status === "cancelled", `status=${sent2?.status}`);
    }
  } else {
    pass("booking succeeds", false, "no future slot");
  }
}

// ===========================================================================
// (f) runs persist across a restart (DB-backed run store)
// ===========================================================================
console.log("\n== (f) run persistence ==");

{
  const lead = await newTestLead({ firstName: "Persist" });
  const run = await repo.createAutomationRun({
    businessId: bizId, leadId: lead.id, ruleKind: "create_human_task", runAt: Date.now() + 7_200_000,
    payload: { priority: "low", reason: "persistence-test" },
  });
  createdRunIds.push(run!.id);

  // "Restart" simulation: a fresh engine invocation (new process would read the
  // same SQLite file — the run store is the DB, not memory). Before its time:
  // the run survives, still pending, not executed.
  await runAutomationEngine();
  const afterFirstPass = await repo.getAutomationRunById(bizId, run!.id);
  pass("run survives an engine pass / process boundary (still pending)", afterFirstPass?.status === "pending", `status=${afterFirstPass?.status}`);

  // Another "boot": re-query via a fresh repo read — row + payload intact.
  const reread = await repo.getAutomationRunById(bizId, run!.id);
  pass("run row + payload persisted (id, runAt, kind intact)",
    !!reread && reread.ruleKind === "create_human_task" && reread.runAt > Date.now() && payloadOf(reread).reason === "persistence-test", `kind=${reread?.ruleKind}`);

  // When it comes due it fires exactly once.
  await forceDue(run!.id);
  await runAutomationEngine();
  const fired = await repo.getAutomationRunById(bizId, run!.id);
  pass("persisted run fires when due (done, attempts=1)", fired?.status === "done" && fired?.attempts === 1, `status=${fired?.status} attempts=${fired?.attempts}`);
}

// ===========================================================================
// Tenant isolation: events + runs carry business_id
// ===========================================================================
console.log("\n== tenant isolation ==");
{
  const evs = await listEvents(bizId, 500);
  pass("all test events scoped to the business", evs.every((e) => e.businessId === bizId), `count=${evs.length}`);
  const runs = await repo.listAutomationRuns(bizId, 500);
  pass("all test runs scoped to the business", runs.every((r) => r.businessId === bizId), `count=${runs.length}`);
}

// ===========================================================================
// Summary
// ===========================================================================

console.log(failures === 0 ? "\nAUTO-TEST: ALL PASS" : `\nAUTO-TEST: ${failures} FAILURE(S)`);

// ---------------------------------------------------------------------------
// Cleanup — remove every row this test created (demo DB stays clean).
// Default rules + demo data stay. Custom rules named auto_test_* are removed.
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
    db.delete(s.events).where(eq(s.events.leadId, l.id)).run();
    db.delete(s.automationRuns).where(eq(s.automationRuns.leadId, l.id)).run();
    db.delete(s.followUps).where(eq(s.followUps.leadId, l.id)).run();
    db.delete(s.appointments).where(eq(s.appointments.leadId, l.id)).run();
    db.delete(s.humanTasks).where(eq(s.humanTasks.leadId, l.id)).run();
    db.delete(s.agentActions).where(eq(s.agentActions.leadId, l.id)).run();
    db.delete(s.leads).where(eq(s.leads.id, l.id)).run();
  }
  for (const rid of createdRuleIds) {
    db.delete(s.automationRules).where(eq(s.automationRules.id, rid)).run();
    db.delete(s.automationRuns).where(eq(s.automationRuns.ruleId, rid)).run();
  }
  for (const rid of createdRunIds) {
    db.delete(s.automationRuns).where(eq(s.automationRuns.id, rid)).run();
  }
  console.log(`cleanup done (${leads.length} test leads removed)`);
} catch (e) {
  console.error("cleanup error:", e);
}
process.exit(failures === 0 ? 0 : 1);
