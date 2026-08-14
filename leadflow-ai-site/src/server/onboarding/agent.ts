/**
 * ONBOARDING SETUP-STEP REMINDER AGENT (dogfooding Phase 2 / Chunk E).
 *
 * When a new customer business is provisioned on the platform, a sequence of
 * honest setup-step reminder messages (SMS/email via the same follow-up
 * engine) nudges the owner to complete the key onboarding steps:
 *
 *   step 1 — complete the knowledge base (business info / FAQs)
 *   step 2 — connect the calendar (so the AI can book real appointments)
 *   step 3 — add services + pricing
 *   step 4 — add the website + embed the chat widget
 *
 * Trigger: the default rule `onboarding_reminders` subscribes to
 * BUSINESS_CREATED (emitted by the admin tenant-provisioning route) and fires
 * `schedule_onboarding_reminders` (delay 0) through the formal tool registry
 * (validated + tenant-scoped + audited). The action persists FOUR follow_up
 * rows (templateKey "onboarding_step_1..4") backed by their own automation
 * runs on the SAME scheduling layer as follow-up sequences (spec §29) and
 * appointment reminders (Phase 1b) — zero schema change.
 *
 * Delays are per-business via the rule's actionConfig (`delay_days`, defaults
 * day 1 / day 3 / day 7 / day 14 from business creation), config-only.
 *
 * Fire-time re-check (mirrors appointmentStillBooked): each reminder only
 * sends if its step is STILL INCOMPLETE at fire time (real repo state — KB
 * rows == 0, calendar not connected, no services, no website). A completed
 * step cancels its reminder silently; the generic stop rules never kill these
 * rows (they are excluded in cancelFollowUpsForLead and handled BEFORE the
 * stop-rule branch in sendFollowUpRow) — the step-completion check on the run
 * IS the stop mechanism.
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
import { createOnboardingReminderRun } from "../automations/runs";

export const ONBOARDING_TEMPLATE_PREFIX = "onboarding_step_";
export const ONBOARDING_STEPS = [1, 2, 3, 4] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Default per-step delays (days from business creation) — 1 / 3 / 7 / 14. */
export const ONBOARDING_DEFAULT_DELAY_DAYS: Record<number, number> = { 1: 1, 2: 3, 3: 7, 4: 14 };

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OnboardingScheduleResult {
  status: "scheduled" | "skipped" | "already-scheduled";
  followUpIds?: string[];
  channel?: "sms" | "email";
  reason?: string;
  delayDays?: Record<number, number>;
}

export interface OnboardingSendResult {
  followUpId: string;
  status: "sent" | "cancelled" | "skipped";
  /** Reminder rows are not sequence steps — always null (SendFollowUpResult shape). */
  step: number | null;
  channel?: "sms" | "email" | "none";
  reason?: string;
}

export function onboardingTemplateKey(step: number): string {
  return `${ONBOARDING_TEMPLATE_PREFIX}${step}`;
}

export function onboardingStepOf(templateKey: string | null): number | null {
  const m = /^onboarding_step_(\d+)$/.exec(templateKey ?? "");
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Config — per-business delays (rule actionConfigJson, config-only)
// ---------------------------------------------------------------------------

/**
 * The business's setup-step delay days. Stored on the `onboarding_reminders`
 * automation rule's actionConfig (`delay_days: { "1": 1, "2": 3, "3": 7, "4": 14 }`)
 * — the same per-business config surface the other default rules use. A
 * missing/invalid value falls back to the default for that step.
 */
export async function getOnboardingDelayDays(businessId: string): Promise<Record<number, number>> {
  try {
    const rules = await repo.listAutomationRules(businessId);
    const rule = rules.find((r) => r.name === "onboarding_reminders");
    if (rule?.actionConfigJson) {
      const cfg = JSON.parse(rule.actionConfigJson) as { delay_days?: Record<string, unknown> };
      const raw = cfg.delay_days;
      if (raw && typeof raw === "object") {
        const out: Record<number, number> = {};
        for (const step of ONBOARDING_STEPS) {
          const v = Number(raw[String(step)]);
          out[step] = Number.isFinite(v) && v >= 0 ? v : ONBOARDING_DEFAULT_DELAY_DAYS[step];
        }
        return out;
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...ONBOARDING_DEFAULT_DELAY_DAYS };
}

// ---------------------------------------------------------------------------
// Owner recipient lead — the follow-up engine sends to a lead, so the business
// owner is modeled as a lead (source "onboarding"). Found-or-created idempotent.
// ---------------------------------------------------------------------------

async function findOwnerLead(businessId: string, ownerEmail: string): Promise<{ id: string } | null> {
  const leads = await repo.listLeads(businessId, 1000);
  return leads.find((l) => l.email === ownerEmail && l.source === "onboarding") ?? null;
}

/**
 * The owner (recipient) as a lead. Created once per business (source
 * "onboarding", status "new"); the reminder follow-up rows attach to it. This
 * keeps onboarding messages on the SAME follow-up engine + stop-rule surface
 * as every other message, with zero schema change.
 */
export async function ensureOwnerLead(businessId: string): Promise<{ id: string } | null> {
  const business = await repo.getBusinessById(businessId);
  if (!business) return null;
  const owner = business.ownerId ? await repo.getUserById(business.ownerId) : null;
  const email = owner?.email ?? business.email ?? "";
  if (!email && !business.phone) return null; // no reachable channel at all
  const existing = email ? await findOwnerLead(businessId, email) : null;
  if (existing) return existing;
  const name = owner?.name ?? business.name ?? "Owner";
  const [firstName, ...rest] = name.split(" ").filter(Boolean);
  return repo.createLead({
    businessId,
    firstName: firstName || "Owner",
    lastName: rest.join(" "),
    phone: business.phone || "",
    email,
    source: "onboarding",
    serviceRequested: "",
  });
}

// ---------------------------------------------------------------------------
// Scheduling (rule action `schedule_onboarding_reminders` — via the registry
// tool, validated + tenant-scoped + audited)
// ---------------------------------------------------------------------------

function isOnboardingRow(f: { templateKey: string | null; status: string }): boolean {
  return (f.templateKey ?? "").startsWith(ONBOARDING_TEMPLATE_PREFIX) && ["pending", "paused"].includes(f.status);
}

/**
 * Schedule the four setup-step reminders for a new business. Called by the
 * automation engine through the `schedule_onboarding_reminders` tool on
 * BUSINESS_CREATED.
 *   - idempotent per business (re-emitted events don't duplicate reminders),
 *   - fully-onboarded businesses (onboardingCompleted) are skipped entirely,
 *   - skips when there is no reachable channel (phone/email) or the owner
 *     lead opted out — silently.
 */
export async function scheduleOnboardingReminders(businessId: string): Promise<OnboardingScheduleResult> {
  const business = await repo.getBusinessById(businessId);
  if (!business) return { status: "skipped", reason: "no-business" };
  if (business.onboardingCompleted === 1) return { status: "skipped", reason: "onboarding-complete" };

  const ownerLead = await ensureOwnerLead(businessId);
  if (!ownerLead) return { status: "skipped", reason: "no-channel" };
  const lead = await repo.getLeadById(businessId, ownerLead.id);
  if (!lead) return { status: "skipped", reason: "no-lead" };
  if (lead.optedOut === 1) return { status: "skipped", reason: "opted-out" };
  const channel = lead.phone ? "sms" : lead.email ? "email" : null;
  if (!channel) return { status: "skipped", reason: "no-channel" };

  // Idempotent per business: any pending onboarding reminder means this
  // business was already wired (e.g. a dispatch retry).
  const rows = await repo.listFollowUpsWithLead(businessId, 500);
  if (rows.some((r) => isOnboardingRow(r.followUp))) {
    return { status: "already-scheduled", reason: "pending-reminders-exist" };
  }

  const delayDays = await getOnboardingDelayDays(businessId);
  const followUpIds: string[] = [];
  for (const step of ONBOARDING_STEPS) {
    const scheduledFor = business.createdAt + delayDays[step] * DAY_MS;
    const followUpId = await repo.createFollowUp(businessId, {
      leadId: lead.id,
      type: channel,
      scheduledFor,
      templateKey: onboardingTemplateKey(step),
    });
    await createOnboardingReminderRun(businessId, {
      leadId: lead.id,
      followUpId,
      scheduledFor,
      type: channel,
      step,
      businessCreatedAt: business.createdAt,
    });
    followUpIds.push(followUpId);
  }
  await repo.logAgentAction(businessId, {
    agent: "onboarding",
    action: "schedule_onboarding_reminders",
    leadId: lead.id,
    input: { businessId, channel, delayDays, businessCreatedAt: business.createdAt },
    result: { followUpIds, scheduledFor: followUpIds.map((_, i) => business.createdAt + delayDays[i + 1] * DAY_MS) },
    success: true,
  });
  return { status: "scheduled", followUpIds, channel, delayDays };
}

// ---------------------------------------------------------------------------
// Fire-time re-check (never remind for a completed step — real repo state)
// ---------------------------------------------------------------------------

export interface StepVerdict {
  complete: boolean;
  reason: string;
}

/**
 * Is the setup step already complete? Queries REAL repo state — no flags, no
 * fabricated signals:
 *   step 1 (knowledge base)  — any KB row (business info / FAQs) exists
 *   step 2 (calendar)        — calendar integration status is "connected"
 *                               (a mock provider doesn't book real appointments)
 *   step 3 (services)        — at least one service (with pricing) exists
 *   step 4 (widget)          — the business has a website to embed the widget on
 */
export async function stepComplete(businessId: string, step: number): Promise<StepVerdict> {
  const business = await repo.getBusinessById(businessId);
  if (!business) return { complete: true, reason: "no-business" };
  switch (step) {
    case 1: {
      const kb = await repo.listKnowledge(businessId);
      return kb.length > 0 ? { complete: true, reason: "knowledge-base-present" } : { complete: false, reason: "no-knowledge-base" };
    }
    case 2: {
      const integrations = await repo.listIntegrations(businessId);
      const cal = integrations.find((i) => i.provider === "calendar");
      return cal?.status === "connected" ? { complete: true, reason: "calendar-connected" } : { complete: false, reason: `calendar-${cal?.status ?? "missing"}` };
    }
    case 3: {
      const services = await repo.listServices(businessId);
      return services.length > 0 ? { complete: true, reason: "services-present" } : { complete: false, reason: "no-services" };
    }
    case 4: {
      const website = (business.website ?? "").trim();
      return website ? { complete: true, reason: "website-set" } : { complete: false, reason: "no-website" };
    }
    default:
      return { complete: true, reason: `unknown-step-${step}` };
  }
}

// ---------------------------------------------------------------------------
// Templates (professional + friendly, honest — no fabricated claims, no
// invented deadlines or urgency). Placeholders: {{business_name}},
// {{owner_name}}, {{step}}, {{setup_item}}. Opt-out on every message.
// ---------------------------------------------------------------------------

interface OnboardingTemplateData {
  firstName: string;
  businessName: string;
  ownerName: string | null;
  step: number;
}

function stepLabel(step: number): string {
  switch (step) {
    case 1:
      return "add your business info and FAQs";
    case 2:
      return "connect your calendar";
    case 3:
      return "add your services and pricing";
    case 4:
      return "add your website and embed the chat widget";
    default:
      return "finish setting up your account";
  }
}

function stepSpecificSms(step: number): string {
  switch (step) {
    case 1:
      return "Your AI receptionist answers customer questions from this info — the more you add, the more accurate it gets.";
    case 2:
      return "With your calendar connected, the AI can book real appointments on your real availability — never invented times.";
    case 3:
      return "With services and pricing in place, the AI can qualify leads for exactly the work you do.";
    case 4:
      return "Once embedded, the widget lets every website visitor reach you instantly — day or night.";
    default:
      return "";
  }
}

export function onboardingSmsBody(d: OnboardingTemplateData): string {
  const name = d.firstName || "there";
  const owner = d.ownerName ? ` — ${d.ownerName}` : "";
  const item = stepLabel(d.step);
  const specific = stepSpecificSms(d.step);
  return `Hi ${name}, this is ${d.businessName}. Next setup step: ${item}.${specific ? ` ${specific}` : ""} Need help? Just reply to this text.${owner} (Reply STOP to opt out.)`;
}

export function onboardingEmail(d: OnboardingTemplateData): { subject: string; html: string } {
  const name = d.firstName || "there";
  const subject = `${d.businessName} — next setup step: ${stepLabel(d.step)}`;
  const html = `<p>Hi ${name},</p>
<p>Thanks for setting up ${d.businessName} with LeadFlow AI. Here's the next step: <strong>${stepLabel(d.step)}</strong>.</p>
<p>${stepSpecificSms(d.step)}</p>
<p>When you're ready, log in and complete it — it usually takes a few minutes. If you'd like a hand, just reply to this email and we'll walk you through it.</p>
<p>— ${d.ownerName ?? "The LeadFlow AI team"}</p>
<p style="color:#888;font-size:12px">Automated setup reminder sent via LeadFlow AI. Reply "STOP" or "unsubscribe" to opt out.</p>`;
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Send (called by the follow-up engine's sendFollowUpRow for this template
// family — the engine's ONE send path)
// ---------------------------------------------------------------------------

/**
 * Send a due onboarding setup-step reminder. Re-checks the step is STILL
 * INCOMPLETE at fire time (stepComplete) and cancels silently when the step is
 * done or the business is fully onboarded — a reminder that no longer applies
 * is NEVER sent.
 */
export async function sendOnboardingReminder(
  businessId: string,
  f: { id: string; leadId: string; type: "sms" | "email"; attempts: number; templateKey: string | null },
  lead: { id: string; firstName: string; lastName: string | null; phone: string | null; email: string | null; optedOut: number; status: string },
  runPayload: Record<string, unknown>
): Promise<OnboardingSendResult> {
  const step = typeof runPayload.step === "number" ? runPayload.step : onboardingStepOf(f.templateKey);
  if (!step || ![1, 2, 3, 4].includes(step)) {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step: null, status: "cancelled", reason: "no-step" };
  }

  // Fire-time re-check — the setup_step_completed guard on the run. A step
  // that is done (or a fully-onboarded business) never gets its reminder.
  const business = await repo.getBusinessById(businessId);
  if (business?.onboardingCompleted === 1) {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step, status: "cancelled", reason: "onboarding-complete" };
  }
  const verdict = await stepComplete(businessId, step);
  if (verdict.complete) {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step, status: "cancelled", reason: verdict.reason };
  }
  if (lead.optedOut === 1 || lead.status === "customer") {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step, status: "cancelled", reason: lead.optedOut === 1 ? "opted-out" : "customer" };
  }
  // Spec §39 — follow-up agent disabled globally: skip (audited, never stalls).
  if (!(await isAgentEnabled("followup"))) {
    await repo.updateFollowUp(businessId, f.id, { status: "skipped" });
    await repo.logAgentAction(businessId, {
      agent: "onboarding",
      action: "send_onboarding_reminder",
      leadId: lead.id,
      input: { followUpId: f.id, step },
      result: { blocked: true, reason: "followup-agent-disabled" },
      success: false,
    });
    return { followUpId: f.id, step, status: "skipped", reason: "agent-disabled" };
  }

  const ownerName = business?.ownerId ? (await repo.getUserById(business.ownerId))?.name ?? null : null;
  const d: OnboardingTemplateData = { firstName: lead.firstName, businessName: business?.name ?? "Your business", ownerName, step };

  if (f.type === "sms" && lead.phone) {
    const body = onboardingSmsBody(d);
    const res = await getSmsProvider().send({ to: lead.phone, body });
    await repo.logAgentAction(businessId, {
      agent: "onboarding",
      action: "send_sms",
      leadId: lead.id,
      input: { to: lead.phone, templateKey: onboardingTemplateKey(step), body },
      result: { provider: getSmsProvider().name, id: res.id },
      success: true,
    });
    // Spec §32 — every SMS send counts toward the monthly usage budget.
    await recordSmsUsage({ businessId, leadId: lead.id, agent: "onboarding", body, meta: { templateKey: onboardingTemplateKey(step) } });
  } else if (f.type === "email" && lead.email) {
    const { subject, html } = onboardingEmail(d);
    const res = await getEmailProvider().send({ to: lead.email, subject, html });
    await repo.logAgentAction(businessId, {
      agent: "onboarding",
      action: "send_email",
      leadId: lead.id,
      input: { to: lead.email, templateKey: onboardingTemplateKey(step), subject },
      result: { provider: getEmailProvider().name, id: res.id },
      success: true,
    });
  } else {
    await repo.updateFollowUp(businessId, f.id, { status: "skipped" });
    return { followUpId: f.id, step, status: "skipped", reason: "no-channel" };
  }

  await repo.updateFollowUp(businessId, f.id, { status: "sent", attempts: f.attempts + 1 });
  await repo.createNotification(businessId, {
    kind: "onboarding",
    title: `Onboarding reminder sent — step ${step} of 4 (${stepLabel(step)})`,
    body: `${f.type.toUpperCase()} · ${lead.firstName} ${lead.lastName ?? ""}`.trim(),
  });
  await emitEvent({
    type: "FOLLOWUP_SENT",
    businessId,
    leadId: lead.id,
    payload: { followUpId: f.id, type: f.type, step: null, templateKey: onboardingTemplateKey(step) },
  });
  return { followUpId: f.id, step, status: "sent", channel: f.type };
}
