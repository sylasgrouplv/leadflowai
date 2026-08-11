/**
 * Follow-up Agent (spec §9) — the automated 1/3/7/14-day sequence plus the
 * server-side scheduler that drives it.
 *
 * Model (AI BRAIN 3 — rebuilt onto the automation engine, spec §29): a
 * follow-up row per step, templateKey `seq_<n>`, and EVERY row is backed by a
 * persisted automation_run (ruleKind "followup_step_send", run_at = the step's
 * scheduledFor). `startSequence` creates step 1 + its run; when a run fires the
 * automation worker calls the registry's `send_followup` tool (validated +
 * audited), which sends the message, marks the row sent, and creates the next
 * step + run from the business's (owner-customizable) config, scheduled
 * relative to the original trigger so gaps stay at the configured day offsets.
 *
 * Stop rules (all work — they cancel the follow_up rows AND their runs):
 *   - lead books an appointment      -> cancelFollowUpsForLead in the booking agent
 *   - lead becomes a customer        -> cancelFollowUpsForLead on status completion
 *   - lead opts out                  -> optOutLead() + keyword handling in chat
 *   - employee/owner manually stops  -> stopSequence() / per-row cancel
 * The engine also re-checks the row is still pending at fire time, so a
 * stopped sequence can never send.
 *
 * Every send is logged to agent_actions (spec §26 send_sms/send_email), a
 * FOLLOWUP_SENT event is emitted, and a notification is created for the owner.
 */
import * as repo from "../db/repo";
import type { FollowUpStepConfig, FollowUpListItem } from "../db/repo";
import { getEmailProvider, getSmsProvider } from "../integrations";
import { emitEvent } from "../ai/events";
import { createFollowUpStepRun } from "../automations/runs";
import { recordSmsUsage } from "../usage/record";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Templates (plain, honest, no manufactured urgency)
// ---------------------------------------------------------------------------

function leadName(lead: { firstName: string; lastName: string | null }): string {
  return `${lead.firstName} ${lead.lastName ?? ""}`.trim() || "there";
}

function smsBodyFor(step: number, business: { name: string }, lead: { firstName: string; lastName: string | null; serviceRequested: string | null }): string {
  const first = lead.firstName || "there";
  const service = lead.serviceRequested ? ` about your ${lead.serviceRequested.toLowerCase()}` : "";
  const onService = lead.serviceRequested ? ` on your ${lead.serviceRequested.toLowerCase()}` : "";
  if (step === 1) return `Hi ${first}, it's ${business.name}${service ? ` — we spoke${service}` : ""}. Want us to come by soon? Reply and we'll set up a time. (Reply STOP to opt out.)`;
  if (step === 2) return `Hi ${first}, just checking in from ${business.name}${onService}. Still interested in a free estimate? Reply and we'll get you on the calendar. (Reply STOP to opt out.)`;
  if (step === 3) return `Hi ${first}, this is ${business.name}. We haven't heard back${service} — happy to answer any questions. We'd love to help. (Reply STOP to opt out.)`;
  return `Hi ${first}, last note from ${business.name} — if your ${lead.serviceRequested?.toLowerCase() || "project"} is still on your mind, we're here. Otherwise we'll close your file. (Reply STOP to opt out.)`;
}

function emailFor(step: number, business: { name: string }, lead: { firstName: string; lastName: string | null; serviceRequested: string | null }) {
  const first = lead.firstName || "there";
  const service = lead.serviceRequested ? ` regarding your ${lead.serviceRequested.toLowerCase()}` : "";
  const subject = step <= 2 ? `${business.name} — quick follow-up${service}` : `${business.name} — checking in${service}`;
  const html = `<p>Hi ${first},</p><p>${subject}.</p><p>We'd be glad to answer questions or set up a visit at a time that works for you — just reply to this email.</p><p style="color:#888;font-size:12px">Sent by ${business.name} via LeadFlow AI. Reply "STOP" or "unsubscribe" to opt out.</p>`;
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Sequence control
// ---------------------------------------------------------------------------

function stepFor(followUp: { templateKey: string | null }): number | null {
  const m = /^seq_(\d+)$/.exec(followUp.templateKey ?? "");
  return m ? Number(m[1]) : null;
}

function nextStepOf(config: FollowUpStepConfig[], step: number): FollowUpStepConfig | null {
  return config.find((s) => s.step === step + 1 && s.enabled) ?? null;
}

/** Start (or restart) the configured sequence for a lead — creates step 1 + its run.
 *  Idempotent: if a pending sequence already exists, it is NOT reset. */
export async function startSequence(businessId: string, leadId: string): Promise<{ started: boolean; scheduledFor: number | null; reason?: string }> {
  const lead = await repo.getLeadById(businessId, leadId);
  if (!lead) return { started: false, scheduledFor: null, reason: "no-lead" };
  if (lead.optedOut === 1) return { started: false, scheduledFor: null, reason: "opted-out" };

  const config = await repo.getFollowUpConfig(businessId);
  const first = config.find((s) => s.step === 1 && s.enabled);
  if (!first) return { started: false, scheduledFor: null, reason: "sequence-disabled" };

  const existing = await repo.listFollowUpsWithLead(businessId, 500);
  const hasPendingSeq = existing.some((r) => r.followUp.leadId === leadId && /^seq_/.test(r.followUp.templateKey ?? "") && ["pending", "paused"].includes(r.followUp.status));
  if (hasPendingSeq) return { started: false, scheduledFor: null, reason: "already-scheduled" };

  const scheduledFor = Date.now() + first.days * DAY_MS;
  const followUpId = await repo.createFollowUp(businessId, { leadId, type: first.type, scheduledFor, templateKey: first.templateKey });
  await createFollowUpStepRun(businessId, { leadId, followUpId, scheduledFor, templateKey: first.templateKey, type: first.type });
  await repo.logAgentAction(businessId, {
    agent: "followup",
    action: "schedule_followup",
    leadId,
    input: { templateKey: first.templateKey, days: first.days, scheduledFor },
    result: { ok: true },
    success: true,
  });
  return { started: true, scheduledFor };
}

/** Manual stop (employee/owner): cancels all pending rows for the lead + runs. */
export async function stopSequence(businessId: string, leadId: string): Promise<number> {
  const n = await repo.cancelFollowUpsForLead(businessId, leadId);
  await repo.logAgentAction(businessId, {
    agent: "followup",
    action: "stop_followup",
    leadId,
    input: { all: true },
    result: { cancelled: n },
    success: true,
  });
  return n;
}

/** Lead opted out (spec §9 stop rule + safety rule 6): stop everything + event. */
export async function optOutLead(businessId: string, leadId: string, channel: "sms" | "email" | "all" = "all"): Promise<void> {
  const lead = await repo.getLeadById(businessId, leadId);
  if (!lead) return;
  await repo.updateLead(businessId, leadId, { optedOut: 1, optOutChannel: channel });
  await repo.cancelFollowUpsForLead(businessId, leadId);
  await repo.logAgentAction(businessId, {
    agent: "followup",
    action: "opt_out",
    leadId,
    input: { channel },
    result: { ok: true },
    success: true,
  });
  await emitEvent({ type: "CUSTOMER_OPTED_OUT", businessId, leadId, payload: { channel } });
}

// ---------------------------------------------------------------------------
// Sending — ONE implementation, used by the registry's send_followup tool and
// (for backward compat) by the old runFollowUpScheduler.
// ---------------------------------------------------------------------------

export interface SendFollowUpResult {
  followUpId: string;
  status: "sent" | "skipped" | "cancelled";
  step: number | null;
  reason?: string;
  nextScheduledFor?: number | null;
}

/**
 * Send one due follow-up: re-checks stop rules + channel reachability, sends
 * via the mock providers (logged), emits FOLLOWUP_SENT, and advances the
 * sequence (next step + run) when this was a sequence row.
 * Throws for a missing/non-pending row so callers (the engine) see the error.
 */
export async function sendFollowUpRow(businessId: string, followUpId: string): Promise<SendFollowUpResult> {
  const f = await repo.getFollowUpById(businessId, followUpId);
  if (!f) throw new Error("Follow-up not found");
  if (f.status !== "pending") throw new Error(`Follow-up is not pending (${f.status})`);

  const lead = await repo.getLeadById(businessId, f.leadId);
  if (!lead) {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId, status: "cancelled", step: stepFor(f), reason: "no-lead" };
  }
  // Stop rules evaluated at send time (safety over schedule).
  if (lead.optedOut === 1 || ["appointment_booked", "customer"].includes(lead.status)) {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId, status: "cancelled", step: stepFor(f), reason: `stop-${lead.status === "appointment_booked" ? "booked" : lead.status}` };
  }

  const step = stepFor(f);
  const config = await repo.getFollowUpConfig(businessId);
  // Step disabled in config -> skip sending but keep flowing if a later
  // step is enabled (only for sequence rows).
  if (step && !config.some((s) => s.step === step && s.enabled)) {
    await repo.updateFollowUp(businessId, f.id, { status: "skipped" });
    await advanceSequence(f, config, Date.now());
    return { followUpId, status: "skipped", step, reason: "step-disabled", nextScheduledFor: null };
  }

  // Channel reachability: no phone -> can't SMS, no email -> can't email.
  if (f.type === "sms" && !lead.phone) {
    await repo.updateFollowUp(businessId, f.id, { status: "skipped" });
    await advanceSequence(f, config, Date.now());
    return { followUpId, status: "skipped", step, reason: "no-phone", nextScheduledFor: null };
  }
  if (f.type === "email" && !lead.email) {
    await repo.updateFollowUp(businessId, f.id, { status: "skipped" });
    await advanceSequence(f, config, Date.now());
    return { followUpId, status: "skipped", step, reason: "no-email", nextScheduledFor: null };
  }

  const business = await repo.getBusinessById(businessId);
  const businessName = business?.name ?? "Your service provider";
  if (f.type === "sms" && lead.phone) {
    const body = smsBodyFor(step ?? 1, { name: businessName }, lead);
    const res = await getSmsProvider().send({ to: lead.phone, body });
    await repo.logAgentAction(businessId, {
      agent: "followup",
      action: "send_sms",
      leadId: lead.id,
      input: { to: lead.phone, templateKey: f.templateKey ?? "", body },
      result: { provider: getSmsProvider().name, id: res.id },
      success: true,
    });
    // Spec §32 — every SMS send counts toward the monthly usage budget.
    await recordSmsUsage({ businessId, leadId: lead.id, agent: "followup", body, meta: { templateKey: f.templateKey ?? "" } });
  } else if (f.type === "email" && lead.email) {
    const { subject, html } = emailFor(step ?? 1, { name: businessName }, lead);
    const res = await getEmailProvider().send({ to: lead.email, subject, html });
    await repo.logAgentAction(businessId, {
      agent: "followup",
      action: "send_email",
      leadId: lead.id,
      input: { to: lead.email, templateKey: f.templateKey ?? "", subject },
      result: { provider: getEmailProvider().name, id: res.id },
      success: true,
    });
  }

  await repo.updateFollowUp(businessId, f.id, { status: "sent", attempts: f.attempts + 1 });
  await repo.createNotification(businessId, {
    kind: "followup",
    title: `Follow-up sent — ${leadName(lead)}`,
    body: `Step ${step ?? "manual"} · ${f.type.toUpperCase()}${lead.serviceRequested ? ` · ${lead.serviceRequested}` : ""}`,
  });
  await emitEvent({
    type: "FOLLOWUP_SENT",
    businessId,
    leadId: lead.id,
    payload: { followUpId: f.id, type: f.type, step, templateKey: f.templateKey ?? "" },
  });

  const advanced = await advanceSequence(f, config, Date.now());
  return { followUpId, status: "sent", step, nextScheduledFor: advanced };
}

// ---------------------------------------------------------------------------
// Scheduler (backward-compat wrapper) — the automation engine is now the
// driver (src/server/automations/engine.ts); this kept-function runs the same
// send path for anything that still calls it directly.
// ---------------------------------------------------------------------------

export interface SchedulerRun {
  checked: number;
  sent: number;
  skipped: number;
  cancelled: number;
  errors: number;
}

export async function runFollowUpScheduler(now = Date.now()): Promise<SchedulerRun> {
  const run: SchedulerRun = { checked: 0, sent: 0, skipped: 0, cancelled: 0, errors: 0 };
  const due = await repo.listDueFollowUps(100, now);
  for (const f of due) {
    run.checked += 1;
    try {
      const res = await sendFollowUpRow(f.businessId, f.id);
      if (res.status === "sent") run.sent += 1;
      else if (res.status === "skipped") run.skipped += 1;
      else run.cancelled += 1;
    } catch (e) {
      run.errors += 1;
      console.error("[followup] scheduler error:", e);
    }
  }
  return run;
}

/**
 * After a sequence step fires (or is skipped), schedule the next enabled step
 * relative to the original trigger: scheduledFor_next = scheduledFor_this +
 * (days[next] - days[current]) * DAY. Returns the next scheduledFor or null.
 */
async function advanceSequence(fired: { businessId: string; leadId: string; templateKey: string | null; scheduledFor: number }, config: FollowUpStepConfig[], now: number): Promise<number | null> {
  const step = stepFor(fired);
  if (step === null) return null; // manual / one-off rows never advance
  const current = config.find((s) => s.step === step);
  const next = nextStepOf(config, step);
  if (!current || !next) return null;
  const scheduledFor = fired.scheduledFor + (next.days - current.days) * DAY_MS;
  const dueAt = Math.max(scheduledFor, now + 5 * 60_000);
  const followUpId = await repo.createFollowUp(fired.businessId, {
    leadId: fired.leadId,
    type: next.type,
    scheduledFor: dueAt,
    templateKey: next.templateKey,
  });
  await createFollowUpStepRun(fired.businessId, { leadId: fired.leadId, followUpId, scheduledFor: dueAt, templateKey: next.templateKey, type: next.type });
  await repo.logAgentAction(fired.businessId, {
    agent: "followup",
    action: "schedule_followup",
    leadId: fired.leadId,
    input: { templateKey: next.templateKey, days: next.days, scheduledFor: dueAt },
    result: { ok: true },
    success: true,
  });
  return dueAt;
}

export type { FollowUpListItem };
