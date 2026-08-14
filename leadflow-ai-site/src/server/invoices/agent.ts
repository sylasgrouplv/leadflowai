/**
 * INVOICE REMINDER AGENT (dogfooding Phase 2 / Chunk H — automation #10).
 *
 * Subscribes to INVOICE_CREATED through the automation engine: the default
 * rule `invoice_reminder` fires `schedule_invoice_reminder` (delay 0), which
 * computes the reminder time — invoice due date minus the business's configured
 * lead time (rule actionConfig `lead_hours`, default 48) — and persists a
 * follow_up row (templateKey "invoice_reminder") backed by its own automation
 * run on the SAME scheduling layer as follow-up sequences and appointment
 * reminders (spec §29).
 *
 * The reminder goes to the CUSTOMER (the invoice's customer_email) modeled as
 * a lead (source "invoice", found-or-created idempotent — the same pattern the
 * Onboarding Agent uses for the owner). The template is honest: real invoice
 * number / amount / due date from the invoice row — never fabricated — with an
 * opt-out line and no manufactured urgency.
 *
 * When the run fires, the engine's `send_followup` tool runs sendFollowUpRow,
 * which delegates to sendInvoiceReminder for this template family. The send
 * path ALWAYS re-checks the invoice at fire time (invoiceStillUnpaid — a paid
 * or cancelled invoice is NEVER reminded); marking an invoice paid/cancelled
 * also cancels its pending reminder immediately (repo.markInvoicePaid /
 * markInvoiceCancelled → cancelInvoiceReminderFollowUp).
 *
 * Sends go through the mock email provider and are audit-logged (spec §26); a
 * FOLLOWUP_SENT event + owner notification are emitted — identical to the
 * follow-up engine's send path.
 *
 * Real Stripe billing stays deferred behind the StripeProvider interface; this
 * module is the in-product invoice + reminder machinery (mock email delivery
 * like all current automations).
 */
import * as repo from "../db/repo";
import { getEmailProvider } from "../integrations";
import { emitEvent } from "../ai/events";
import { isAgentEnabled } from "../platform/settings";
import { createInvoiceReminderRun } from "../automations/runs";

export const INVOICE_REMINDER_TEMPLATE_KEY = "invoice_reminder";
/** Default lead time: remind 48 hours before the invoice is due. */
export const INVOICE_LEAD_TIME_DEFAULT_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;

export interface InvoiceScheduleResult {
  status: "scheduled" | "skipped" | "already-scheduled";
  followUpId?: string;
  scheduledFor?: number;
  channel?: "email";
  reason?: string;
  leadTimeHours?: number;
}

export interface InvoiceSendResult {
  followUpId: string;
  status: "sent" | "cancelled" | "skipped";
  /** Reminder rows are not sequence steps — always null (SendFollowUpResult shape). */
  step: number | null;
  channel?: "email" | "none";
  reason?: string;
}

// ---------------------------------------------------------------------------
// Config — per-business reminder lead time
// ---------------------------------------------------------------------------

/**
 * The business's invoice-reminder lead time in hours. Stored on the
 * `invoice_reminder` automation rule's actionConfig (`lead_hours`) — the same
 * per-business config surface appointment_reminder uses (`reminder_minutes`),
 * config-only, zero schema change. Missing/invalid → default 48 hours before
 * the due date.
 */
export async function getInvoiceReminderLeadTimeHours(businessId: string): Promise<number> {
  try {
    const rules = await repo.listAutomationRules(businessId);
    const rule = rules.find((r) => r.name === "invoice_reminder");
    if (rule?.actionConfigJson) {
      const cfg = JSON.parse(rule.actionConfigJson) as { lead_hours?: unknown };
      const h = Number(cfg.lead_hours);
      if (Number.isFinite(h) && h > 0) return h;
    }
  } catch {
    /* fall through to default */
  }
  return INVOICE_LEAD_TIME_DEFAULT_HOURS;
}

// ---------------------------------------------------------------------------
// Customer recipient lead — the follow-up engine sends to a lead, so the
// invoice customer is modeled as a lead (source "invoice"). Found-or-created
// idempotent (same pattern as ensureOwnerLead in onboarding/agent.ts).
// ---------------------------------------------------------------------------

async function findCustomerLead(businessId: string, email: string): Promise<{ id: string } | null> {
  const leads = await repo.listLeads(businessId, 1000);
  return leads.find((l) => l.email === email && l.source === "invoice") ?? null;
}

/**
 * The customer (recipient) as a lead. Created once per business+customer email
 * (source "invoice", status "new"); the invoice-reminder follow-up rows attach
 * to it. This keeps invoice reminders on the SAME follow-up engine + stop-rule
 * surface as every other message, with zero schema change.
 */
export async function ensureInvoiceCustomerLead(businessId: string, customerName: string, customerEmail: string): Promise<{ id: string } | null> {
  const email = (customerEmail ?? "").trim().toLowerCase();
  if (!email) return null;
  const existing = await findCustomerLead(businessId, email);
  if (existing) return existing;
  const [firstName, ...rest] = (customerName ?? "").trim().split(" ").filter(Boolean);
  return repo.createLead({
    businessId,
    firstName: firstName || "Customer",
    lastName: rest.join(" "),
    phone: "",
    email,
    source: "invoice",
    serviceRequested: "",
  });
}

// ---------------------------------------------------------------------------
// Scheduling (rule action `schedule_invoice_reminder` — via the registry tool,
// validated + tenant-scoped + audited)
// ---------------------------------------------------------------------------

/** The pending invoice-reminder follow-up + its run for an invoice. */
async function findPendingReminder(businessId: string, invoiceId: string): Promise<{ followUp: { id: string }; payload: Record<string, unknown> } | null> {
  const rows = await repo.listFollowUpsWithLead(businessId, 500);
  for (const { followUp } of rows) {
    if (followUp.templateKey !== INVOICE_REMINDER_TEMPLATE_KEY || !["pending", "paused"].includes(followUp.status)) continue;
    const run = await repo.getRunForFollowUp(followUp.id);
    if (!run) continue;
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(run.payloadJson || "{}");
    } catch {
      /* unparsable — ignore this row */
    }
    if (payload.invoiceId === invoiceId) return { followUp: { id: followUp.id }, payload };
  }
  return null;
}

/**
 * Schedule the invoice reminder for an unpaid invoice. Called by the
 * automation engine through the `schedule_invoice_reminder` tool on
 * INVOICE_CREATED.
 *   - idempotent per invoice (re-emitted events don't duplicate the reminder),
 *   - skips when the invoice is already paid/cancelled or the customer lead
 *     opted out — silently, no reminder is scheduled,
 *   - an invoice already inside the lead-time window still gets its reminder —
 *     fired as soon as the next tick allows rather than never.
 */
export async function scheduleInvoiceReminder(businessId: string, invoiceId: string): Promise<InvoiceScheduleResult> {
  const invoice = await repo.getInvoiceById(businessId, invoiceId);
  if (!invoice) return { status: "skipped", reason: "no-invoice" };
  if (invoice.status !== "unpaid") return { status: "skipped", reason: `invoice-${invoice.status}` };

  const customerLead = await ensureInvoiceCustomerLead(businessId, invoice.customerName, invoice.customerEmail);
  if (!customerLead) return { status: "skipped", reason: "no-channel" };
  const lead = await repo.getLeadById(businessId, customerLead.id);
  if (!lead) return { status: "skipped", reason: "no-lead" };
  if (lead.optedOut === 1) return { status: "skipped", reason: "opted-out" };

  const leadTimeHours = await getInvoiceReminderLeadTimeHours(businessId);
  const reminderAt = invoice.dueAt - leadTimeHours * HOUR_MS;

  // Idempotent per invoice — a re-emitted INVOICE_CREATED never duplicates.
  const existing = await findPendingReminder(businessId, invoiceId);
  if (existing) return { status: "already-scheduled", reason: "pending-reminder-exists", leadTimeHours };

  // An invoice inside the lead-time window still gets its reminder — fire as
  // soon as the next tick allows rather than never.
  const scheduledFor = Math.max(reminderAt, repo.now() + 5 * 60_000);
  const followUpId = await repo.createFollowUp(businessId, {
    leadId: lead.id,
    type: "email",
    scheduledFor,
    templateKey: INVOICE_REMINDER_TEMPLATE_KEY,
  });
  await createInvoiceReminderRun(businessId, {
    leadId: lead.id,
    followUpId,
    scheduledFor,
    type: "email",
    invoiceId,
    dueAt: invoice.dueAt,
  });
  await repo.logAgentAction(businessId, {
    agent: "invoice",
    action: "schedule_invoice_reminder",
    leadId: lead.id,
    input: { invoiceId, dueAt: invoice.dueAt, amountCents: invoice.amountCents, customerEmail: invoice.customerEmail },
    result: { followUpId, scheduledFor, channel: "email", leadTimeHours },
    success: true,
  });
  return { status: "scheduled", followUpId, scheduledFor, channel: "email", leadTimeHours };
}

// ---------------------------------------------------------------------------
// Fire-time re-check (a paid / cancelled invoice is NEVER reminded)
// ---------------------------------------------------------------------------

export interface InvoiceStillUnpaidVerdict {
  ok: boolean;
  reason?: string;
}

/** Verify the invoice the reminder was scheduled for is still unpaid + due. */
export async function invoiceStillUnpaid(businessId: string, invoiceId: string, expectedDueAt: number): Promise<InvoiceStillUnpaidVerdict> {
  const invoice = await repo.getInvoiceById(businessId, invoiceId);
  if (!invoice) return { ok: false, reason: "no-invoice" };
  if (invoice.status !== "unpaid") return { ok: false, reason: `invoice-${invoice.status}` };
  if (invoice.dueAt !== expectedDueAt) return { ok: false, reason: "due-changed" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Templates (professional + friendly, honest — real invoice data from the
// invoice row, never fabricated; no manufactured urgency; opt-out on every
// message). Placeholders: {{business_name}}, {{owner_name}}, {{invoice_number}},
// {{amount}}, {{due_date}}.
// ---------------------------------------------------------------------------

interface InvoiceTemplateData {
  firstName: string;
  businessName: string;
  ownerName: string | null;
  invoiceNumber: string;
  amount: string;
  dueDate: string;
}

/** Short human-friendly invoice number (first 8 chars of the uuid, uppercase). */
export function invoiceNumberFor(invoiceId: string): string {
  return invoiceId.slice(0, 8).toUpperCase();
}

/** $X.XX from cents. */
export function fmtAmountCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** e.g. "Mon, Aug 20" (date only — invoices are due on a date, not a time). */
export function fmtDueDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function invoiceEmail(d: InvoiceTemplateData): { subject: string; html: string } {
  const name = d.firstName || "there";
  const subject = `Reminder: invoice ${d.invoiceNumber} from ${d.businessName} — ${d.amount} due ${d.dueDate}`;
  const html = `<p>Hi ${name},</p>
<p>This is a friendly reminder from ${d.businessName} about invoice <strong>${d.invoiceNumber}</strong> for <strong>${d.amount}</strong>, due on <strong>${d.dueDate}</strong>.</p>
<p>If you've already sent payment, thank you — please ignore this message. If you have questions about the invoice or need to arrange a different due date, just reply to this email and we'll help.</p>
<p>— ${d.ownerName ?? d.businessName}, ${d.businessName}</p>
<p style="color:#888;font-size:12px">Automated invoice reminder sent via LeadFlow AI. Reply "STOP" or "unsubscribe" to opt out.</p>`;
  return { subject, html };
}

// ---------------------------------------------------------------------------
// Send (called by the follow-up engine's sendFollowUpRow for this template
// family — the engine's ONE send path)
// ---------------------------------------------------------------------------

/**
 * Send a due invoice reminder. Re-checks the invoice is STILL UNPAID at fire
 * time (invoiceStillUnpaid) and cancels silently for paid/cancelled invoices
 * or opt-outs — a reminder that no longer applies is NEVER sent.
 */
export async function sendInvoiceReminder(
  businessId: string,
  f: { id: string; leadId: string; type: "sms" | "email"; attempts: number; templateKey: string | null },
  lead: { id: string; firstName: string; lastName: string | null; phone: string | null; email: string | null; optedOut: number; status: string },
  runPayload: Record<string, unknown>
): Promise<InvoiceSendResult> {
  const invoiceId = typeof runPayload.invoiceId === "string" ? runPayload.invoiceId : null;
  if (!invoiceId) {
    // No invoice reference (e.g. a backfilled legacy row) — cannot verify,
    // so never send; cancel silently.
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step: null, status: "cancelled", reason: "no-invoice" };
  }
  const expectedDueAt = typeof runPayload.dueAt === "number" ? runPayload.dueAt : 0;
  const verdict = await invoiceStillUnpaid(businessId, invoiceId, expectedDueAt);
  if (!verdict.ok) {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step: null, status: "cancelled", reason: verdict.reason ?? "not-unpaid" };
  }
  if (lead.optedOut === 1 || lead.status === "customer") {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step: null, status: "cancelled", reason: lead.optedOut === 1 ? "opted-out" : "customer" };
  }
  // Spec §39 — follow-up agent disabled globally: skip (audited, never stalls).
  if (!(await isAgentEnabled("followup"))) {
    await repo.updateFollowUp(businessId, f.id, { status: "skipped" });
    await repo.logAgentAction(businessId, {
      agent: "invoice",
      action: "send_invoice_reminder",
      leadId: lead.id,
      input: { followUpId: f.id, invoiceId },
      result: { blocked: true, reason: "followup-agent-disabled" },
      success: false,
    });
    return { followUpId: f.id, step: null, status: "skipped", reason: "agent-disabled" };
  }

  const invoice = await repo.getInvoiceById(businessId, invoiceId);
  if (!invoice) {
    await repo.updateFollowUp(businessId, f.id, { status: "cancelled" });
    return { followUpId: f.id, step: null, status: "cancelled", reason: "no-invoice" };
  }
  const business = await repo.getBusinessById(businessId);
  const businessName = business?.name ?? "Your service provider";
  const ownerName = business?.ownerId ? (await repo.getUserById(business.ownerId))?.name ?? null : null;
  const d: InvoiceTemplateData = {
    firstName: lead.firstName,
    businessName,
    ownerName,
    invoiceNumber: invoiceNumberFor(invoice.id),
    amount: fmtAmountCents(invoice.amountCents),
    dueDate: fmtDueDate(invoice.dueAt),
  };

  // Invoice reminders are email-shaped (the invoice carries customer_email);
  // the customer lead always has that email. If a row was somehow typed sms
  // without a phone, skip (never invent a channel).
  if (f.type === "email" && lead.email) {
    const { subject, html } = invoiceEmail(d);
    const res = await getEmailProvider().send({ to: lead.email, subject, html });
    await repo.logAgentAction(businessId, {
      agent: "invoice",
      action: "send_email",
      leadId: lead.id,
      input: { to: lead.email, templateKey: INVOICE_REMINDER_TEMPLATE_KEY, subject },
      result: { provider: getEmailProvider().name, id: res.id },
      success: true,
    });
  } else {
    await repo.updateFollowUp(businessId, f.id, { status: "skipped" });
    return { followUpId: f.id, step: null, status: "skipped", reason: "no-channel" };
  }

  await repo.updateFollowUp(businessId, f.id, { status: "sent", attempts: f.attempts + 1 });
  await repo.createNotification(businessId, {
    kind: "invoice_reminder",
    title: `Invoice reminder sent — ${d.invoiceNumber} (${d.amount})`,
    body: `${lead.firstName} ${lead.lastName ?? ""}`.trim() + ` · EMAIL · due ${d.dueDate}`,
  });
  await emitEvent({
    type: "FOLLOWUP_SENT",
    businessId,
    leadId: lead.id,
    payload: { followUpId: f.id, type: f.type, step: null, templateKey: INVOICE_REMINDER_TEMPLATE_KEY },
  });
  return { followUpId: f.id, step: null, status: "sent", channel: "email" };
}
