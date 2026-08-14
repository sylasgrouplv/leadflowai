/**
 * Automation action executor (spec §29) — the engine's actions are executed
 * THROUGH THE FORMAL TOOL REGISTRY (validated + tenant-scoped + audited,
 * spec §24–25). The engine never mutates business data directly; it decides
 * and the tools act.
 *
 * Actions:
 *   send_welcome            → send_message (AI welcome) on the lead's active
 *                             conversation, only when it hasn't been greeted yet
 *   start_followup_sequence → schedule_followup (creates step 1 + its run)
 *   send_followup           → send_followup (sends the due follow-up row)
 *   cancel_followups        → stop_followup (stop rules)
 *   create_human_task       → create_human_task (escalations / critical failures)
 *   send_message            → send_message (custom rules)
 *   send_review_request     → send_review_request (Review Agent, spec §21 —
 *                             post-completed-job feedback request)
 *   schedule_appointment_reminder → schedule_appointment_reminder (Phase 1b —
 *                             reminder at appointment start − lead time)
 *   schedule_onboarding_reminders → schedule_onboarding_reminders (Phase 2 —
 *                             setup-step reminders for a new business)
 *   categorize_human_task    → categorize_human_task (Phase 2 — Chunk F:
 *                             deterministic support-ticket categorization of a
 *                             human escalation task + owner notification)
 *   schedule_invoice_reminder → schedule_invoice_reminder (Phase 2 — Chunk H:
 *                             invoice reminder at due date − lead time)
 */
import * as repo from "../db/repo";
import { callAiTool, type ToolContext } from "../ai/tools/registry";

export const ENGINE_CRITICAL_ACTIONS = new Set(["send_followup", "send_welcome", "start_followup_sequence", "send_review_request"]);

const DEFAULT_WELCOME =
  "Hi! Thanks for reaching out — I'm the AI receptionist. How can we help today? Tell me what you need and a little about your situation.";

export interface ExecuteResult {
  ok: boolean;
  /** Human-readable outcome for the run record. */
  result?: unknown;
  error?: string;
}

function toolCtx(businessId: string, leadId: string | null, conversationId: string | null): ToolContext {
  return { businessId, agent: "automation", leadId: leadId ?? undefined, conversationId: conversationId ?? undefined };
}

export async function executeAction(opts: {
  businessId: string;
  leadId: string | null;
  conversationId?: string | null;
  action: string;
  actionConfig: unknown;
}): Promise<ExecuteResult> {
  const { businessId, leadId, conversationId = null } = opts;
  const config = (opts.actionConfig ?? {}) as Record<string, unknown>;
  const ctx = toolCtx(businessId, leadId, conversationId);

  try {
    switch (opts.action) {
      case "send_welcome": {
        if (!leadId) return { ok: true, result: { status: "skipped", reason: "no-lead" } };
        const convs = await repo.listConversations(businessId, { leadIds: [leadId] });
        const active = convs.find((c) => c.conversation.status !== "closed");
        if (!active) return { ok: true, result: { status: "skipped", reason: "no-conversation" } };
        const msgs = await repo.listMessages(businessId, active.conversation.id);
        if (msgs.some((m) => m.sender !== "lead")) return { ok: true, result: { status: "skipped", reason: "already-greeted" } };
        const business = await repo.getBusinessById(businessId);
        let body = DEFAULT_WELCOME;
        if (business) {
          try {
            const policies = JSON.parse(business.policiesJson || "{}");
            if (typeof policies.welcomeMessage === "string" && policies.welcomeMessage) body = policies.welcomeMessage;
          } catch {
            /* keep default */
          }
        }
        if (typeof config.body === "string" && config.body) body = config.body;
        const msg = await callAiTool("send_message", ctx, { conversation_id: active.conversation.id, body });
        return { ok: true, result: { status: "sent", messageId: (msg as { id?: string })?.id ?? null } };
      }

      case "start_followup_sequence": {
        if (!leadId) return { ok: false, error: "no-lead" };
        const res = await callAiTool("schedule_followup", ctx, { lead_id: leadId });
        return { ok: true, result: res };
      }

      case "send_followup": {
        const followUpId = typeof config.followUpId === "string" ? config.followUpId : null;
        if (!followUpId) return { ok: false, error: "no-followUpId-in-config" };
        const res = await callAiTool("send_followup", ctx, { follow_up_id: followUpId });
        return { ok: true, result: res };
      }

      case "cancel_followups": {
        if (!leadId) return { ok: false, error: "no-lead" };
        const res = await callAiTool("stop_followup", ctx, { lead_id: leadId });
        return { ok: true, result: res };
      }

      case "create_human_task": {
        if (!leadId) return { ok: false, error: "no-lead" };
        const res = await callAiTool("create_human_task", ctx, {
          lead_id: leadId,
          priority: typeof config.priority === "string" ? config.priority : "medium",
          reason: typeof config.reason === "string" ? config.reason : "automation-created task",
          recommended_action: typeof config.recommended_action === "string" ? config.recommended_action : undefined,
        });
        return { ok: true, result: res };
      }

      case "send_message": {
        const convId = typeof config.conversation_id === "string" ? config.conversation_id : conversationId;
        const body = typeof config.body === "string" ? config.body : "";
        if (!convId || !body) return { ok: false, error: "send_message needs conversation_id + body" };
        const res = await callAiTool("send_message", ctx, { conversation_id: convId, body });
        return { ok: true, result: res };
      }

      case "send_review_request": {
        // The appointment id comes from the JOB_COMPLETED run payload — the
        // engine forwards it into actionConfig before this switch runs.
        const appointmentId = typeof config.appointment_id === "string" ? config.appointment_id : null;
        if (!appointmentId) return { ok: false, error: "no-appointmentId-in-config" };
        const res = await callAiTool("send_review_request", ctx, { appointment_id: appointmentId });
        return { ok: true, result: res };
      }

      case "schedule_appointment_reminder": {
        // The appointment id comes from the APPOINTMENT_BOOKED run payload —
        // the engine forwards it into actionConfig before this switch runs.
        // The action computes the reminder time (startAt minus the business's
        // configured lead time) and persists the reminder follow-up + run.
        const appointmentId = typeof config.appointment_id === "string" ? config.appointment_id : null;
        if (!appointmentId) return { ok: false, error: "no-appointmentId-in-config" };
        const res = await callAiTool("schedule_appointment_reminder", ctx, { appointment_id: appointmentId });
        return { ok: true, result: res };
      }

      case "schedule_onboarding_reminders": {
        // BUSINESS_CREATED → schedule the business's setup-step reminders
        // (knowledge base / calendar / services / widget at day 1/3/7/14 from
        // business creation). No input needed — everything comes from the
        // tool's tenant context; idempotent per business.
        const res = await callAiTool("schedule_onboarding_reminders", ctx, {});
        return { ok: true, result: res };
      }
      case "categorize_human_task": {
        // The human task id comes from the HUMAN_ESCALATION event payload
        // captured on the run (createHumanTaskRecord emits payload
        // { taskId, priority, reason }) — the engine forwards it into
        // actionConfig before this switch runs.
        const taskId = typeof config.human_task_id === "string" ? config.human_task_id : null;
        if (!taskId) return { ok: false, error: "no-human_task_id-in-config" };
        const res = await callAiTool("categorize_human_task", ctx, { human_task_id: taskId });
        return { ok: true, result: res };
      }

      case "schedule_invoice_reminder": {
        // The invoice id comes from the INVOICE_CREATED run payload — the
        // engine forwards it into actionConfig before this switch runs.
        // The action computes the reminder time (due date minus the business's
        // configured lead time) and persists the reminder follow-up + run.
        const invoiceId = typeof config.invoice_id === "string" ? config.invoice_id : null;
        if (!invoiceId) return { ok: false, error: "no-invoice_id-in-config" };
        const res = await callAiTool("schedule_invoice_reminder", ctx, { invoice_id: invoiceId });
        return { ok: true, result: res };
      }

      default:
        return { ok: false, error: `unknown-action:${opts.action}` };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}
