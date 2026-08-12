/**
 * DOGFOODING PHASE 1b (gap-analysis Chunk D) acceptance test — appointment
 * reminders on the automation engine.
 *
 * Exercises:
 *   T1  default `appointment_reminder` rule materializes for new tenants
 *       (via the dogfood seed path ensureDogfoodRules — 5 default rules)
 *   T2  APPOINTMENT_BOOKED → engine → reminder follow-up row + run scheduled
 *       at (appointment start − lead time, default 120 minutes)
 *   T3  re-emitted APPOINTMENT_BOOKED is idempotent (no duplicate reminder)
 *   T4  reminder send path: due run → SMS via provider (audited), row sent,
 *       FOLLOWUP_SENT emitted, owner notification created
 *   T5  fire-time re-check: cancelled appointment → reminder cancelled, never sent
 *   T6  fire-time re-check: rescheduled appointment (startAt mismatch, no
 *       re-emit) → reminder cancelled, never sent
 *   T7  reschedule refresh: APPOINTMENT_BOOKED re-emit → stale reminder
 *       replaced by one at the NEW start time
 *   T8  no-channel lead (no phone/email) → nothing scheduled (silent skip)
 *   T9  opted-out lead → nothing scheduled
 *   T10 config surface: rule actionConfig reminder_minutes drives the offset
 *   T11 template placeholders (business_name / owner_name / service / time),
 *       honest + STOP/opt-out language, no fabricated claims
 *   T12 bulk prospect import unaffected: LEAD_CREATED never schedules reminders
 *   T13 direct scheduleAppointmentReminder idempotency (already-scheduled)
 *
 * Style: matches import-test.ts (in-process suites) — repo functions + the
 * automation engine, local SQLite, tenant-scoped cleanup.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run reminder-test.ts
 *       (HTTP-free, so it also runs from /home/team/shared/site)
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
  scheduleAppointmentReminder,
  reminderSmsBody,
  reminderEmail,
  getReminderLeadTimeMinutes,
  REMINDER_LEAD_TIME_DEFAULT_MINUTES,
} from "./src/server/reminders/agent";
import { sendFollowUpRow } from "./src/server/followups/engine";

runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();

/** Same tenant-scoped cleanup as import-test / dogfood-test (FK-safe). */
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
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

(async () => {
  // ------------------------------------------------------------ setup tenant
  const stamp = Date.now();
  const owner = await repo.createUser({
    name: "Reminder Test Owner",
    email: `reminder-owner-${stamp}@test.local`,
    passwordHash: "$2b$10$test", // unused — no auth exercised here
    role: "owner",
  });
  const business = await repo.createBusiness({ ownerId: owner.id, name: "Reminder Test Co", category: "home_services" });
  const bizId = business.id;
  const service = await repo.addService(bizId, { name: "Furnace Tune-Up", description: "Annual tune-up", priceCents: 9900, durationMin: 60 });
  const svcId = service.id;

  // ------------------------------------------------------------ T1 rule
  await ensureDogfoodRules(bizId); // the dogfood seed path (5 default rules)
  const rules = await repo.listAutomationRules(bizId);
  const reminderRule = rules.find((r) => r.name === "appointment_reminder");
  pass(
    "T1 appointment_reminder default rule wired",
    !!reminderRule && reminderRule.triggerEvent === "APPOINTMENT_BOOKED" && reminderRule.action === "schedule_appointment_reminder" && reminderRule.conditionJson.includes("none"),
    reminderRule ? `${reminderRule.triggerEvent}→${reminderRule.action} delay=${reminderRule.delayMs}` : "missing"
  );
  pass("T1b five default rules (dogfood)", rules.length === 5, `n=${rules.length}`);
  const cfg = reminderRule?.actionConfigJson ? (JSON.parse(reminderRule.actionConfigJson) as { reminder_minutes?: number }) : {};
  pass("T1c default lead time 120 in rule actionConfig", cfg.reminder_minutes === 120, JSON.stringify(cfg));

  const makeLead = async (over: { firstName?: string; phone?: string; email?: string; optedOut?: number } = {}) => {
    const lead = await repo.createLead({
      businessId: bizId,
      firstName: over.firstName ?? "Reminder",
      lastName: "Test",
      // "" = no channel (empty strings are stored as-is and treated as no contact).
      phone: over.phone === undefined ? "(517) 555-1000" : over.phone,
      email: over.email ?? "",
      source: "website_chat",
      serviceRequested: "Furnace Tune-Up",
    });
    if (over.optedOut) await repo.updateLead(bizId, lead.id, { optedOut: 1 });
    return lead;
  };

  /** Create an appointment + emit APPOINTMENT_BOOKED exactly like the booking agent does, then run the engine. */
  async function bookAndEmit(leadId: string, startAt: number): Promise<{ id: string }> {
    const appt = await repo.createAppointment({ businessId: bizId, leadId, serviceId: svcId, startAt, endAt: startAt + HOUR, status: "booked" });
    await emitEvent({
      type: "APPOINTMENT_BOOKED",
      businessId: bizId,
      leadId,
      payload: { appointmentId: appt.id, serviceId: svcId, startAt, endAt: startAt + HOUR, serviceName: "Furnace Tune-Up" },
    });
    await runAutomationEngine();
    return appt;
  }

  async function reminderRowsFor(leadId: string) {
    const rows = await db
      .select()
      .from(s.followUps)
      .where(and(eq(s.followUps.businessId, bizId), eq(s.followUps.leadId, leadId)))
      .execute();
    return rows.filter((r) => r.templateKey === "appointment_reminder");
  }
  async function reminderRunsFor(leadId: string) {
    const runs = await db
      .select()
      .from(s.automationRuns)
      .where(and(eq(s.automationRuns.businessId, bizId), eq(s.automationRuns.leadId, leadId)))
      .execute();
    return runs.filter((r) => r.ruleKind === "followup_step_send" && (r.payloadJson ?? "").includes("appointment_reminder"));
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
    const lead = await makeLead({ firstName: "Scheduled" });
    const startAt = Date.now() + 3 * DAY;
    const appt = await bookAndEmit(lead.id, startAt);
    const rows = await reminderRowsFor(lead.id);
    const runs = await reminderRunsFor(lead.id);
    const expected = startAt - REMINDER_LEAD_TIME_DEFAULT_MINUTES * MIN;
    pass("T2 reminder follow-up row scheduled", rows.length === 1 && rows[0]!.status === "pending" && rows[0]!.type === "sms", rows.length ? `${rows[0]!.status} type=${rows[0]!.type} at=${rows[0]!.scheduledFor}` : "none");
    pass("T2b scheduled at start − lead time (120m)", rows.length === 1 && rows[0]!.scheduledFor === expected, `scheduledFor=${rows[0]?.scheduledFor} expected=${expected}`);
    pass("T2c reminder run materialized (ruleKind followup_step_send, ruleId null)", runs.length === 1 && runs[0]!.ruleId === null && runs[0]!.runAt === expected, runs.length ? `runAt=${runs[0]!.runAt}` : "none");
    pass("T2d run payload carries appointment id + start", runs.length === 1 && payloadOf(runs[0]!).appointmentId === appt.id && payloadOf(runs[0]!).startAt === startAt, JSON.stringify(runs[0] ? payloadOf(runs[0]) : {}).slice(0, 120));
  }

  // ------------------------------------------------------------ T3 idempotency
  {
    const lead = await makeLead({ firstName: "Idempotent" });
    const startAt = Date.now() + 4 * DAY;
    const appt = await bookAndEmit(lead.id, startAt);
    // Re-emit the same event (e.g. dispatch retry) + run the engine again.
    await emitEvent({
      type: "APPOINTMENT_BOOKED",
      businessId: bizId,
      leadId: lead.id,
      payload: { appointmentId: appt.id, serviceId: svcId, startAt, endAt: startAt + HOUR, serviceName: "Furnace Tune-Up" },
    });
    await runAutomationEngine();
    const rows = await reminderRowsFor(lead.id);
    pass("T3 re-emitted event does not duplicate the reminder", rows.filter((r) => r.status === "pending").length === 1, rows.map((r) => r.status).join(","));
  }

  // ------------------------------------------------------------ T4 send path
  {
    const lead = await makeLead({ firstName: "SendMe" });
    const startAt = Date.now() + 2 * DAY;
    const appt = await bookAndEmit(lead.id, startAt);
    const runs = await reminderRunsFor(lead.id);
    await repo.updateAutomationRun(bizId, runs[0]!.id, { runAt: Date.now() - 5_000 }); // make due
    const engine = await runAutomationEngine();
    const rows = await reminderRowsFor(lead.id);
    const actions = await repo.listAgentActions(bizId, 400);
    const sms = actions.find((a) => a.action === "send_sms" && a.leadId === lead.id && (a.inputJson ?? "").includes("appointment_reminder"));
    const body = sms ? (JSON.parse(sms.inputJson) as { body?: string }).body ?? "" : "";
    const events = await repo.listEvents(bizId, { limit: 300 });
    const notifications = await db.select().from(s.notifications).where(eq(s.notifications.businessId, bizId)).execute();
    pass("T4 reminder sent (row status sent)", rows[0]?.status === "sent", rows[0]?.status ?? "none");
    pass("T4b SMS audited via reminder agent", !!sms && sms.agent === "reminder", sms ? `${sms.agent}` : "no sms action");
    pass(
      "T4c body has business + service + time, honest opt-out",
      body.includes("Reminder Test Co") && body.includes("Furnace Tune-Up") && body.includes("Reply STOP"),
      body.slice(0, 160)
    );
    pass("T4d FOLLOWUP_SENT emitted for the reminder", events.some((e) => e.type === "FOLLOWUP_SENT" && e.leadId === lead.id && (e.payloadJson ?? "").includes("appointment_reminder")), "");
    pass("T4e owner notification created", notifications.some((n) => n.kind === "reminder"), notifications.map((n) => n.kind).join(","));
    pass("T4f engine executed without failures", engine.failed === 0 && engine.executed > 0, `executed=${engine.executed} failed=${engine.failed}`);
  }

  // ------------------------------------------------------------ T5 cancelled
  {
    const lead = await makeLead({ firstName: "CancelMe" });
    const startAt = Date.now() + 2 * DAY;
    const appt = await bookAndEmit(lead.id, startAt);
    await repo.updateAppointment(bizId, appt.id, { status: "cancelled" });
    const runs = await reminderRunsFor(lead.id);
    await repo.updateAutomationRun(bizId, runs[0]!.id, { runAt: Date.now() - 5_000 });
    await runAutomationEngine();
    const rows = await reminderRowsFor(lead.id);
    const actions = await repo.listAgentActions(bizId, 400);
    const sent = actions.some((a) => a.action === "send_sms" && a.leadId === lead.id);
    pass("T5 cancelled appointment → reminder cancelled, never sent", rows[0]?.status === "cancelled" && !sent, `row=${rows[0]?.status} sent=${sent}`);
  }

  // ------------------------------------------------------------ T6 rescheduled (stale send guard)
  {
    const lead = await makeLead({ firstName: "ReschedGuard" });
    const startAt1 = Date.now() + 2 * DAY;
    const appt = await bookAndEmit(lead.id, startAt1);
    // Out-of-band reschedule (no re-emit — e.g. legacy path): startAt changes.
    await repo.updateAppointment(bizId, appt.id, { startAt: startAt1 + DAY, endAt: startAt1 + DAY + HOUR, status: "booked" });
    const runs = await reminderRunsFor(lead.id);
    await repo.updateAutomationRun(bizId, runs[0]!.id, { runAt: Date.now() - 5_000 });
    await runAutomationEngine();
    const rows = await reminderRowsFor(lead.id);
    const actions = await repo.listAgentActions(bizId, 400);
    const sent = actions.some((a) => a.action === "send_sms" && a.leadId === lead.id);
    pass("T6 rescheduled (startAt mismatch) → reminder cancelled, never sent at stale time", rows[0]?.status === "cancelled" && !sent, `row=${rows[0]?.status} sent=${sent}`);
  }

  // ------------------------------------------------------------ T7 reschedule refresh (re-emit)
  {
    const lead = await makeLead({ firstName: "ReschedRefresh" });
    const startAt1 = Date.now() + 2 * DAY;
    const appt = await bookAndEmit(lead.id, startAt1);
    const startAt2 = startAt1 + DAY;
    await repo.updateAppointment(bizId, appt.id, { startAt: startAt2, endAt: startAt2 + HOUR, status: "booked" });
    // The real rescheduleAppointmentAction re-emits APPOINTMENT_BOOKED.
    await emitEvent({
      type: "APPOINTMENT_BOOKED",
      businessId: bizId,
      leadId: lead.id,
      payload: { appointmentId: appt.id, serviceId: svcId, startAt: startAt2, endAt: startAt2 + HOUR, serviceName: "Furnace Tune-Up" },
    });
    await runAutomationEngine();
    const rows = await reminderRowsFor(lead.id);
    const pending = rows.filter((r) => r.status === "pending");
    const expected = startAt2 - REMINDER_LEAD_TIME_DEFAULT_MINUTES * MIN;
    pass("T7 stale reminder replaced (old cancelled, new pending)", rows.length === 2 && pending.length === 1 && rows.some((r) => r.status === "cancelled"), rows.map((r) => r.status).join(","));
    pass("T7b new reminder scheduled at the NEW start time", pending.length === 1 && pending[0]!.scheduledFor === expected, `scheduledFor=${pending[0]?.scheduledFor} expected=${expected}`);
  }

  // ------------------------------------------------------------ T8 no channel
  {
    const lead = await makeLead({ firstName: "NoChannel", phone: "", email: "" });
    await bookAndEmit(lead.id, Date.now() + 2 * DAY);
    const rows = await reminderRowsFor(lead.id);
    pass("T8 no-channel lead → nothing scheduled (silent skip)", rows.length === 0, `n=${rows.length}`);
  }

  // ------------------------------------------------------------ T9 opted out
  {
    const lead = await makeLead({ firstName: "OptedOut", optedOut: 1 });
    await bookAndEmit(lead.id, Date.now() + 2 * DAY);
    const rows = await reminderRowsFor(lead.id);
    pass("T9 opted-out lead → nothing scheduled", rows.length === 0, `n=${rows.length}`);
  }

  // ------------------------------------------------------------ T10 config surface
  {
    const rule = (await repo.listAutomationRules(bizId)).find((r) => r.name === "appointment_reminder")!;
    await repo.updateAutomationRule(bizId, rule.id, { actionConfigJson: JSON.stringify({ reminder_minutes: 30 }) });
    const leadTime = await getReminderLeadTimeMinutes(bizId);
    const lead = await makeLead({ firstName: "ConfigLead" });
    const startAt = Date.now() + 2 * DAY;
    await bookAndEmit(lead.id, startAt);
    const rows = await reminderRowsFor(lead.id);
    pass("T10 config surface: reminder_minutes=30 drives offset", leadTime === 30 && rows[0]?.scheduledFor === startAt - 30 * MIN, `leadTime=${leadTime} scheduledFor=${rows[0]?.scheduledFor}`);
    // Restore default for the remaining tests.
    await repo.updateAutomationRule(bizId, rule.id, { actionConfigJson: JSON.stringify({ reminder_minutes: REMINDER_LEAD_TIME_DEFAULT_MINUTES }) });
  }

  // ------------------------------------------------------------ T11 templates
  {
    const sms = reminderSmsBody({ firstName: "Jane", businessName: "Reminder Test Co", ownerName: "Owner Name", serviceName: "Furnace Tune-Up", timeStr: "Mon, Aug 20 at 9:00 AM" });
    const email = reminderEmail({ firstName: "Jane", businessName: "Reminder Test Co", ownerName: "Owner Name", serviceName: "Furnace Tune-Up", timeStr: "Mon, Aug 20 at 9:00 AM" });
    pass(
      "T11 SMS template placeholders + opt-out, honest",
      sms.includes("Reminder Test Co") && sms.includes("Furnace Tune-Up") && sms.includes("Mon, Aug 20 at 9:00 AM") && sms.includes("Reply STOP"),
      sms.slice(0, 140)
    );
    pass(
      "T11b email template uses business_name/owner_name/service/time",
      email.subject.includes("Furnace Tune-Up") && email.subject.includes("Reminder Test Co") && email.html.includes("Owner Name") && email.html.includes("Mon, Aug 20 at 9:00 AM") && email.html.includes("opt out"),
      email.subject
    );
  }

  // ------------------------------------------------------------ T12 bulk import unaffected
  {
    const before = await db.select().from(s.automationRuns).where(eq(s.automationRuns.businessId, bizId)).execute();
    const beforeWelcome = before.filter((r) => r.ruleKind === "lead_created_welcome").length;
    const beforeReminderKind = before.filter((r) => r.ruleKind === "appointment_reminder").length;
    const lead = await makeLead({ firstName: "ImportLead" });
    await emitEvent({ type: "LEAD_CREATED", businessId: bizId, leadId: lead.id, payload: { source: "prospect_import" } });
    await runAutomationEngine();
    const after = await db.select().from(s.automationRuns).where(eq(s.automationRuns.businessId, bizId)).execute();
    const afterWelcome = after.filter((r) => r.ruleKind === "lead_created_welcome").length;
    const afterReminderKind = after.filter((r) => r.ruleKind === "appointment_reminder").length;
    pass(
      "T12 LEAD_CREATED never schedules reminders (welcome only)",
      afterWelcome === beforeWelcome + 1 && afterReminderKind === beforeReminderKind,
      `welcome=${afterWelcome} (was ${beforeWelcome}) reminderKind=${afterReminderKind} (was ${beforeReminderKind})`
    );
  }

  // ------------------------------------------------------------ T13 direct idempotency
  {
    const lead = await makeLead({ firstName: "DirectIdem" });
    const appt = await repo.createAppointment({ businessId: bizId, leadId: lead.id, serviceId: svcId, startAt: Date.now() + 3 * DAY, endAt: Date.now() + 3 * DAY + HOUR, status: "booked" });
    const first = await scheduleAppointmentReminder(bizId, appt.id);
    const second = await scheduleAppointmentReminder(bizId, appt.id);
    const rows = await reminderRowsFor(lead.id);
    pass("T13 direct schedule is idempotent per appointment", first.status === "scheduled" && second.status === "already-scheduled" && rows.filter((r) => r.status === "pending").length === 1, `${first.status} → ${second.status}`);
  }

  // ------------------------------------------------------------ cleanup
  await wipeBusiness(bizId);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("reminder-test crashed:", err);
  process.exit(1);
});
