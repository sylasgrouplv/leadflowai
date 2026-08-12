/**
 * APPOINTMENT REMINDER AGENT (dogfooding Phase 1b / gap-analysis Chunk D).
 *
 * Subscribes to APPOINTMENT_BOOKED through the automation engine: the default
 * rule `appointment_reminder` fires `schedule_appointment_reminder` (delay 0),
 * which computes the reminder time — appointment start minus the business's
 * configured lead time (rule actionConfig `reminder_minutes`, default 120) —
 * and persists a follow_up row (templateKey "appointment_reminder") backed by
 * its own automation run. That is the SAME scheduling layer as follow-up
 * sequences (spec §29): the run's run_at is the reminder time, and the worker
 * picks it up when due.
 *
 * When the run fires, the engine's `send_followup` tool runs sendFollowUpRow,
 * which delegates to sendAppointmentReminder for this template family. The
 * send path ALWAYS re-checks the appointment at fire time
 * (appointmentStillBooked — spec safety rules: never remind a cancelled,
 * rescheduled, or already-started appointment); a reminder that no longer
 * applies is cancelled silently (never sent).
 *
 * Sends go through the mock SMS/email providers and are audit-logged (spec
 * §26); every SMS counts toward the monthly usage budget (spec §32) and a
 * FOLLOWUP_SENT event + owner notification are emitted — identical to the
 * follow-up engine's send path.
 */
import * as repo from "../db/repo";
import { getEmailProvider, getSmsProvider } from "../integrations";
import { emitEvent } from "../ai/events";
import { recordSmsUsage } from "../usage/record";
import { isAgentEnabled } from "../platform/settings";
import { fmtShort } from "../appointments/agent";
import { createAppointmentReminderRun } from "../automations/runs";

export const REMINDER_TEMPLATE_KEY = "appointment_reminder";
export const REMINDER_LEAD_TIME_DEFAULT_MINUTES = 120;
const MINUTE_MS = 60_000;

export interface ReminderScheduleResult {
  status: "scheduled" | "skipped" | "already-scheduled";
  followUpId?: string;
  scheduledFor?: number;
  channel?: "sms" | "email";
  reason?: string;
  leadTimeMinutes?: number;
}

export interface ReminderSendResult {
  followUpId: string;
  status: "sent" | "cancelled" | "skipped";
  /** Reminder rows are not sequence steps — always null (SendFollowUpResult shape). */
  step: number | null;
  channel?: "sms" | "email" | "none";
  reason?: string;
}

// ---------------------------------------------------------------------------
// Config — per-business reminder lead time
// ---------------------------------------------------------------------------

/**
 * The business's reminder lead time in minutes. Stored on the
 * `appointment_reminder` automation rule's actionConfig (`reminder_minutes`),
 * which is the per-business config surface the other default rules use
 * (default 120 minutes before the appointment start). Config-only — no schema
 * change.
 */
export async function getReminderLeadTimeMinutes(businessId: string): Promise<number> {
  try {
    const rules = await repo.listAutomationRules(businessId);
    const rule = rules.find((r) => r.name === "appointment_reminder");
    if (rule?.actionConfigJson) {
      const cfg = JSON.parse(rule.actionConfigJson) as { reminder_minutes?: unknown };
      const m = Number(cfg.reminder_minutes);
      if (Number.isFinite(m) && m > 0) return m;
    }
  } catch {
    /* fall through to default */
  }
  return REMINDER_LEAD_TIME_DEFAULT_MINUTES;
}

// ---------------------------------------------------------------------------
// Scheduling (rule action `schedule_appointment_reminder` — via the registry
// tool, validated + tenant-scoped + audited)
// ---------------------------------------------------------------------------

/** The pending (or paused) reminder follow-up + its run for an appointment. */
async function findPendingReminder(
  businessId: string,
  leadId: string,
  appointmentId: string
): Promise<{ followUp: { id: string }; payload: Record<string, unknown> } | null> {
  const rows = await repo.listFollowUpsWithLead(businessId, 500);
  for (const { followUp } of rows) {
    if (followUp.leadId !== leadId || followUp.templateKey !== REMINDER_TEMPLATE_KEY || !["pending", "paused"].includes(followUp.status)) continue;
    const run = await repo.getRunForFollowUp(followUp.id);
    if (!run) continue;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(run.payloadJson || "{}");
    } catch {
      /* unparsable — ignore this row */
    }
    if (payload.appointmentId === appointmentId) return { followUp: { id: followUp.id }, payload };
  }
  return null;
}

/**
 * Schedule (or refresh) the appointment reminder for a booked appointment.
 * Called by the automation engine through the `schedule_appointment_reminder`
 * tool on APPOINTMENT_BOOKED.
 *   - idempotent per appointment + start time (re-emitted events don't
 *     duplicate the reminder),
 *   - a rescheduled appointment (startAt changed) replaces the stale pending
 *     reminder instead of duplicating it,
 *   - skips when there is no reachable channel (phone/email) or the lead
 *     opted out — silently, no reminder is scheduled.
 */
export async function scheduleAppointmentReminder(businessId: string, appointmentId: string): Promise<ReminderScheduleResult> {
  const appointment = await repo.getAppointmentById(businessId, appointmentId);
  if (!appointment) return { status: "skipped", reason: "no-appointment" };
  if (!["booked", "confirmed"].includes(appointment.status)) return { status: "skipped", reason: `appointment-${appointment.status}` };

  const lead = appointment.leadId ? await repo.getLeadById(businessId, appointment.leadId) : null;
  if (!lead) return { status: "skipped", reason: "no-lead" };
  if (lead.optedOut === 1) return { status: "skipped", reason: "opted-out" };
  const channel = lead.phone ? "sms" : lead.email ? "email" : null;
  if (!channel) return { status: "skipped", reason: "no-channel" };

  const leadTimeMinutes = await getReminderLeadTimeMinutes(businessId);
  const reminderAt = appointment.startAt - leadTimeMinutes * MINUTE_MS;

  // Idempotent per appointment + start time; a reschedule replaces the stale
  // pending reminder (row + run cancelled, fresh one scheduled).
  const existing = await findPendingReminder(businessId, lead.id, appointmentId);
  if (existing) {
    if (existing.payload.startAt === appointment.startAt) {
      return { status: "already-scheduled", reason: "pending-reminder-exists", leadTimeMinutes };
    }
    await repo.updateFollowUp(businessId, existing.followUp.id, { status: "cancelled" });
    const staleRun = await repo.getRunForFollowUp(existing.followUp.id);
    if (staleRun) await repo.updateAutomationRun(businessId, staleRun.id, { status: "cancelled", lastError: "rescheduled" });
  }

  // An appointment inside the lead-time window still gets a reminder — fire
  // as soon as the next tick allows rather than never.
  const scheduledFor = Math.max(reminderAt, repo.now() + 5 * MINUTE_MS);
  const followUpId = await repo.createFollowUp(businessId, {
    leadId: lead.id,
    type: channel,
    scheduledFor,
    templateKey: REMINDER_TEMPLATE_KEY,
  });
  await createAppointmentReminderRun(businessId, {
    leadId: lead.id,
    followUpId,
    scheduledFor,
    type: channel,
    appointmentId,
    startAt: appointment.startAt,
  });
  await repo.logAgentAction(businessId, {
    agent: "reminder",
    action: "schedule_appointment_reminder",
    leadId: lead.id,
    input: { appointmentId, startAt: appointment.startAt, serviceId: appointment.serviceId ?? null },
    result: { followUpId, scheduledFor, channel, leadTimeMinutes },
    success: true,
  });
  return { status: "scheduled", followUpId, scheduledFor, channel, leadTimeMinutes };
}

// ---------------------------------------------------------------------------
// Fire-time re-check (never remind a cancelled / rescheduled / past appointment)
// ---------------------------------------------------------------------------

export interface StillBookedVerdict {
  ok: boolean;
  reason?: string;
}

/** Verify the appointment the reminder was scheduled for still applies. */
export async function appointmentStillBooked(businessId: string, appointmentId: string, expectedStartAt: number): Promise<StillBookedVerdict> {
  const appointment = await repo.getAppointmentById(businessId, appointmentId);
  if (!appointment) return { ok: false, reason: "no-appointment" };
  if (!["booked", "confirmed"].includes(appointment.status)) return { ok: false, reason: `appointment-${appointment.status}` };
  if (appointment.startAt !== expectedStartAt) return { ok: false, reason: "rescheduled" };
  if (appointment.startAt <= Date.now()) return { ok: false, reason: "already-started" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Templates (professional + friendly, honest — no fabricated claims). The
// placeholders the template family supports: {{business_name}}, {{owner_name}},
// {{service}}, {{appointment_time}}.
// ---------------------------------------------------------------------------

interface ReminderTemplateData {
  firstName: string;
  businessName: string;
  ownerName: string | null;
  serviceName: string;
  timeStr: string;
}

export function reminderSmsBody(d: ReminderTemplateData): string {
  const name = d.firstName || "there";
  const owner = d.ownerName ? ` — ${d.ownerName}` : "";
  return `Hi ${name}, this is ${d.businessName}. Friendly reminder that your ${d.serviceName} appointment is on ${d.timeStr}. Need to reschedule? Just reply to this text.${owner} (Reply STOP to opt out.)`;
}

export function reminderEmail(d: ReminderTemplateData): { subject: string; html: string } {
  const name = d.firstName || "there";
  const subject = `Reminder: your ${d.serviceName} with ${d.businessName} — ${d.timeStr}`;
  const html = `<p>Hi ${name},</p>
<p>This is a friendly reminder from ${d.businessName} about your ${d.serviceName} appointment on <strong>${d.timeStr}</strong>.</p>
<p>Need to reschedule or have questions? Just reply to this email — we're happy to help.</p>
<p>— ${d.ownerName ?? d.businessName}, ${d.businessName}</p>
<p style="color:#888;font-size:12px">Automated reminder sent via LeadFlow AI. Reply "STOP" to opt out.</p>`;
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Send (called by the follow-up engine's sendFollowUpRow for this template
// family — the engine's ONE send path)
// ---------------------------------------------------------------------------

/**
 * Send a due appointment reminder. Re-checks the appointment is still booked
 * at fire time (appointmentStillBooked) and cancels silently for
 * cancelled/rescheduled/already-started appointments or opt-outs — a reminder
 * that no longer applies is NEVER sent.
 */
export async function sendAppointmentReminder(
  businessId: string,
  f: { id: string; leadId: string; type: "sms" | "email"; attempts: number },
  lead: { id: string; firstName: string; lastName: string | null; phone: string | null; email: string | null; optedOut: number; status: string },
  runPayload: Record<string, unknown>
): Promise<ReminderSendResult> {
  const appointmentId = typeof runPayload.appointmentId === "string" ? runPayload.appointmentId : null;
  if (!appointmentId) {
    // No appointment reference (e.g. a backfilled legacy row) — cannot verify,
    // so never send; cancel silently.
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step: null, status: "cancelled", reason: "no-appointment" };
  }
  const expectedStartAt = typeof runPayload.startAt === "number" ? runPayload.startAt : 0;
  const verdict = await appointmentStillBooked(businessId, appointmentId, expectedStartAt);
  if (!verdict.ok) {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step: null, status: "cancelled", reason: verdict.reason ?? "not-booked" };
  }
  if (lead.optedOut === 1 || lead.status === "customer") {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step: null, status: "cancelled", reason: lead.optedOut === 1 ? "opted-out" : "customer" };
  }
  // Spec §39 — follow-up agent disabled globally: skip (audited, never stalls).
  if (!(await isAgentEnabled("followup"))) {
    await repo.updateFollowUp(businessId, f.id, { status: "skipped" });
    await repo.logAgentAction(businessId, {
      agent: "reminder",
      action: "send_appointment_reminder",
      leadId: lead.id,
      input: { followUpId: f.id, appointmentId },
      result: { blocked: true, reason: "followup-agent-disabled" },
      success: false,
    });
    return { followUpId: f.id, step: null, status: "skipped", reason: "agent-disabled" };
  }

  const appointment = await repo.getAppointmentById(businessId, appointmentId);
  if (!appointment) {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step: null, status: "cancelled", reason: "no-appointment" };
  }
  const service = appointment.serviceId ? await repo.getServiceById(businessId, appointment.serviceId) : null;
  const business = await repo.getBusinessById(businessId);
  const businessName = business?.name ?? "Your service provider";
  const ownerName = business?.ownerId ? (await repo.getUserById(business.ownerId))?.name ?? null : null;
  const serviceName = service?.name ?? "your service";
  const timeStr = fmtShort(appointment.startAt);
  const d: ReminderTemplateData = { firstName: lead.firstName, businessName, ownerName, serviceName, timeStr };

  if (f.type === "sms" && lead.phone) {
    const body = reminderSmsBody(d);
    const res = await getSmsProvider().send({ to: lead.phone, body });
    await repo.logAgentAction(businessId, {
      agent: "reminder",
      action: "send_sms",
      leadId: lead.id,
      input: { to: lead.phone, templateKey: REMINDER_TEMPLATE_KEY, body },
      result: { provider: getSmsProvider().name, id: res.id },
      success: true,
    });
    // Spec §32 — every SMS send counts toward the monthly usage budget.
    await recordSmsUsage({ businessId, leadId: lead.id, agent: "reminder", body, meta: { templateKey: REMINDER_TEMPLATE_KEY } });
  } else if (f.type === "email" && lead.email) {
    const { subject, html } = reminderEmail(d);
    const res = await getEmailProvider().send({ to: lead.email, subject, html });
    await repo.logAgentAction(businessId, {
      agent: "reminder",
      action: "send_email",
      leadId: lead.id,
      input: { to: lead.email, templateKey: REMINDER_TEMPLATE_KEY, subject },
      result: { provider: getEmailProvider().name, id: res.id },
      success: true,
    });
  } else {
    await repo.updateFollowUp(businessId, f.id, { status: "skipped" });
    return { followUpId: f.id, step: null, status: "skipped", reason: "no-channel" };
  }

  await repo.updateFollowUp(businessId, f.id, { status: "sent", attempts: f.attempts + 1 });
  await repo.createNotification(businessId, {
    kind: "reminder",
    title: `Appointment reminder sent — ${lead.firstName} ${lead.lastName ?? ""}`.trim(),
    body: `${serviceName} · ${f.type.toUpperCase()} · ${timeStr}`,
  });
  await emitEvent({
    type: "FOLLOWUP_SENT",
    businessId,
    leadId: lead.id,
    payload: { followUpId: f.id, type: f.type, step: null, templateKey: REMINDER_TEMPLATE_KEY },
  });
  return { followUpId: f.id, step: null, status: "sent", channel: f.type };
}
