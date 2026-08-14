/**
 * Follow-up run scheduling helpers — AI BRAIN 3.
 *
 * Every follow_up row is backed by an automation_run (ruleKind
 * "followup_step_send", run_at = the step's scheduledFor). The automation
 * worker picks due runs and executes the send through the registry's
 * send_followup tool — so the follow-up sequence IS an automation path
 * (spec §29), with one persisted scheduling layer for everything.
 */
import * as repo from "../db/repo";

function stepNumber(templateKey: string | null): number | null {
  const m = /^(?:seq_|sales_)(\d+)$/.exec(templateKey ?? "");
  return m ? Number(m[1]) : null;
}

export interface FollowUpRunSpec {
  leadId: string;
  followUpId: string;
  scheduledFor: number;
  templateKey: string;
  type: string;
}

export async function createFollowUpStepRun(businessId: string, spec: FollowUpRunSpec) {
  return repo.createAutomationRun({
    businessId,
    leadId: spec.leadId,
    ruleKind: "followup_step_send",
    runAt: spec.scheduledFor,
    payload: { followUpId: spec.followUpId, step: stepNumber(spec.templateKey), templateKey: spec.templateKey, type: spec.type },
  });
}

export interface AppointmentReminderRunSpec {
  leadId: string;
  followUpId: string;
  scheduledFor: number;
  type: string;
  appointmentId: string;
  startAt: number;
}

/**
 * Run backing an appointment-reminder follow-up row (dogfooding Phase 1b —
 * gap-analysis Chunk D). ruleKind "followup_step_send" so the engine's send
 * path and pending-row pre-check apply; the payload carries the appointment id
 * + start time so the reminder can re-check the appointment at fire time.
 */
export async function createAppointmentReminderRun(businessId: string, spec: AppointmentReminderRunSpec) {
  return repo.createAutomationRun({
    businessId,
    leadId: spec.leadId,
    ruleKind: "followup_step_send",
    runAt: spec.scheduledFor,
    payload: {
      followUpId: spec.followUpId,
      step: null,
      templateKey: "appointment_reminder",
      type: spec.type,
      appointmentId: spec.appointmentId,
      startAt: spec.startAt,
    },
  });
}

export interface OnboardingReminderRunSpec {
  leadId: string;
  followUpId: string;
  scheduledFor: number;
  type: string;
  step: number;
  businessCreatedAt: number;
}

/**
 * Run backing an onboarding setup-step reminder follow-up row (dogfooding
 * Phase 2 — Chunk E). ruleKind "followup_step_send" so the engine's send path
 * and pending-row pre-check apply; the payload carries the step + business
 * creation time so the reminder can re-check the step is still incomplete at
 * fire time (completed step → cancelled, never sent).
 */
export async function createOnboardingReminderRun(businessId: string, spec: OnboardingReminderRunSpec) {
  return repo.createAutomationRun({
    businessId,
    leadId: spec.leadId,
    ruleKind: "followup_step_send",
    runAt: spec.scheduledFor,
    payload: {
      followUpId: spec.followUpId,
      step: spec.step,
      templateKey: `onboarding_step_${spec.step}`,
      type: spec.type,
      businessCreatedAt: spec.businessCreatedAt,
    },
  });
}

export interface InvoiceReminderRunSpec {
  leadId: string;
  followUpId: string;
  scheduledFor: number;
  type: string;
  invoiceId: string;
  dueAt: number;
}

/**
 * Run backing an invoice-reminder follow-up row (dogfooding Phase 2 — Chunk H).
 * ruleKind "followup_step_send" so the engine's send path and pending-row
 * pre-check apply; the payload carries the invoice id + due date so the
 * reminder can re-check the invoice is still unpaid at fire time (paid /
 * cancelled invoice → cancelled, never sent).
 */
export async function createInvoiceReminderRun(businessId: string, spec: InvoiceReminderRunSpec) {
  return repo.createAutomationRun({
    businessId,
    leadId: spec.leadId,
    ruleKind: "followup_step_send",
    runAt: spec.scheduledFor,
    payload: {
      followUpId: spec.followUpId,
      step: null,
      templateKey: "invoice_reminder",
      type: spec.type,
      invoiceId: spec.invoiceId,
      dueAt: spec.dueAt,
    },
  });
}
