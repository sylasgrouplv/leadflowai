/**
 * FORMAL TOOL REGISTRY (spec §24–25) — AI BRAIN 2.
 *
 * The single, controlled action layer of the AI Agent Brain. DB = source of
 * truth, AI = decision/conversation layer, tools = the ONLY mutation path the
 * AI has, humans = oversight/exception layer (spec §42).
 *
 * Every tool declares: name, description, input_schema (zod), permission_level
 * (READ | WRITE | HIGH_RISK), validation (tenant scoping + business rules),
 * handler (wraps the existing validated action implementations — nothing is
 * rewritten), and audit_logging (always on).
 *
 * callTool() is the ONE entry point:
 *   1. resolve the tool        → unknown tool: audit + throw
 *   2. zod-validate the input  → invalid: audit + throw
 *   3. permission gate         → HIGH_RISK + caller "ai": REJECTED, audit-logged,
 *                                and a human escalation task is created (§18)
 *   4. tenant validation       → foreign business/lead: audit + throw
 *   5. run the handler         → audit success/failure; §31: failures are never
 *                                silent, critical failures create a human task
 *
 * The AI never touches the database directly and never holds HIGH_RISK tools
 * (spec §24: "AI has NO HIGH-RISK tools initially").
 */
import { z } from "zod";
import * as repo from "../../db/repo";
import { serviceAreaVerdict, type AreaVerdict } from "./area";
import { setStatusAction } from "../status";
import { checkCalendarAction, bookAppointmentAction, updateAppointmentStatusAction } from "../../appointments/agent";
import { startSequence, stopSequence, optOutLead, sendFollowUpRow } from "../../followups/engine";
import { requestReview, recordFeedback } from "../../reviews/agent";
import { emitEvent } from "../events";
import { checkBudgetAlerts } from "../../usage/budget";
import {
  computeLeadScore,
  displayScoreFor,
  mergeDisplayScore,
  type AppointmentIntent,
  type LeadScoreResult,
  type LocationFit,
  type PurchaseIntent,
  type ServiceFit,
  type UrgencyLevel,
} from "./score";
import type { LeadClassification, LeadScore, LeadStatus, HumanTaskPriority } from "../../db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionLevel = "READ" | "WRITE" | "HIGH_RISK";
export type ToolCaller = "ai" | "human";

export interface ToolContext {
  businessId: string;
  /** The agent (or system) invoking the tool — recorded on every audit row. */
  agent: string;
  conversationId?: string;
  /** Optional lead context for audit rows when the input doesn't carry a lead id. */
  leadId?: string;
}

export class ToolError extends Error {
  constructor(
    public code: "unknown_tool" | "invalid_input" | "permission_denied" | "tenant_mismatch" | "handler_failed",
    message: string
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolDef {
  name: string;
  description: string;
  permissionLevel: PermissionLevel;
  /** Zod input schema — validated on every call BEFORE anything else runs. */
  inputSchema: z.ZodTypeAny;
  /** Business-rule / tenant validation. Returns null when OK, else a rejection reason. */
  validate: (ctx: ToolContext, input: any) => Promise<string | null>;
  handler: (ctx: ToolContext, input: any) => Promise<unknown>;
  /** Audit logging is ALWAYS on for every tool (spec §24); the flag stays for introspection. */
  audit: boolean;
}

// ---------------------------------------------------------------------------
// Audit + human-task helpers
// ---------------------------------------------------------------------------

async function writeAudit(ctx: ToolContext, data: { action: string; leadId?: string; input: unknown; result: unknown; success: boolean }) {
  await repo.logAgentAction(ctx.businessId, {
    agent: ctx.agent,
    action: data.action,
    leadId: data.leadId,
    input: data.input,
    result: data.result,
    success: data.success,
  });
}

/** Create a human escalation task (spec §18) + owner notification + event. */
export async function createHumanTaskRecord(
  businessId: string,
  data: { leadId?: string; priority: HumanTaskPriority; reason: string; conversationSummary?: string; recommendedAction?: string }
) {
  const task = await repo.createHumanTask({ businessId, ...data });
  // Surface in the in-app notification bell, matching the escalation title the
  // UI already keys on.
  let title = `Human task — ${data.priority}: ${data.reason.slice(0, 60)}`;
  if (data.leadId) {
    const lead = await repo.getLeadById(businessId, data.leadId);
    if (lead) title = `Needs human attention — ${lead.firstName} ${lead.lastName}`.trim();
  }
  await repo.createNotification(businessId, { kind: "escalation", title, body: data.recommendedAction ?? data.reason });
  // Spec §30: every escalation is an event (Human Escalation Manager path).
  await emitEvent({
    type: "HUMAN_ESCALATION",
    businessId,
    leadId: data.leadId,
    payload: { taskId: task.id, priority: data.priority, reason: data.reason },
  });
  return task;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Best-effort lead resolution for audit rows (ctx → lead_id → appointment → conversation). */
async function resolveAuditLeadId(ctx: ToolContext, input: unknown): Promise<string | undefined> {
  if (ctx.leadId) return ctx.leadId;
  const i = input as Record<string, unknown>;
  if (typeof i?.lead_id === "string" && UUID_RE.test(i.lead_id)) return i.lead_id;
  if (typeof i?.appointment_id === "string" && UUID_RE.test(i.appointment_id)) {
    const appt = await repo.getAppointmentById(ctx.businessId, i.appointment_id);
    return appt?.leadId ?? undefined;
  }
  if (typeof i?.conversation_id === "string" && UUID_RE.test(i.conversation_id)) {
    const conv = await repo.getConversationById(ctx.businessId, i.conversation_id);
    return conv?.leadId ?? undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tenant-scoping validators
// ---------------------------------------------------------------------------

const uuid = (label: string) => z.string().uuid(label);

async function validateLeadInBusiness(ctx: ToolContext, leadId: string): Promise<string | null> {
  const lead = await repo.getLeadById(ctx.businessId, leadId);
  return lead ? null : `lead ${leadId} does not belong to business ${ctx.businessId}`;
}
async function validateServiceInBusiness(ctx: ToolContext, serviceId: string): Promise<string | null> {
  const service = await repo.getServiceById(ctx.businessId, serviceId);
  return service ? null : `service ${serviceId} does not belong to business ${ctx.businessId}`;
}

// ---------------------------------------------------------------------------
// Shared input shapes
// ---------------------------------------------------------------------------

const leadRefSchema = z.object({ lead_id: uuid("lead_id") });
const serviceRefSchema = z.object({ service_id: uuid("service_id") });

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const readOnly: () => Promise<string | null> = async () => null;

export const TOOL_REGISTRY: ToolDef[] = [
  // ============================ READ ======================================
  {
    name: "get_business_info",
    description: "Read this business's context: name, description, services + pricing, service area, hours, policies, knowledge base (spec §4). Tenant-scoped by construction.",
    permissionLevel: "READ",
    inputSchema: z.object({}),
    validate: async (ctx) => (await repo.getBusinessById(ctx.businessId)) ? null : `business ${ctx.businessId} not found`,
    handler: async (ctx) => {
      const business = await repo.getBusinessById(ctx.businessId);
      if (!business) throw new Error("Business not found");
      const [services, knowledge] = await Promise.all([repo.listServices(ctx.businessId), repo.listKnowledge(ctx.businessId)]);
      return {
        id: business.id,
        name: business.name,
        category: business.category,
        description: business.description ?? "",
        services: services.map((s) => ({ id: s.id, name: s.name, description: s.description ?? "", priceCents: s.priceCents, durationMin: s.durationMin })),
        serviceArea: safeJson(business.serviceAreaJson, { zipCodes: [], cities: [] }),
        hours: safeJson(business.hoursJson, {}),
        policies: safeJson(business.policiesJson, {}),
        knowledge: knowledge.map((k) => ({ kind: k.kind, question: k.question ?? "", answer: k.answer })),
      };
    },
    audit: true,
  },
  {
    name: "get_lead",
    description: "Read a lead's current record (contact info, service, location, status, score). Only leads of the requesting business.",
    permissionLevel: "READ",
    inputSchema: leadRefSchema,
    validate: async (ctx, input) => validateLeadInBusiness(ctx, input.lead_id),
    handler: async (ctx, input) => {
      const lead = await repo.getLeadById(ctx.businessId, input.lead_id);
      if (!lead) throw new Error("Lead not found");
      return lead;
    },
    audit: true,
  },
  {
    name: "get_service",
    description: "Read one service (name, description, price, duration). Only services of the requesting business.",
    permissionLevel: "READ",
    inputSchema: serviceRefSchema,
    validate: async (ctx, input) => validateServiceInBusiness(ctx, input.service_id),
    handler: async (ctx, input) => {
      const service = await repo.getServiceById(ctx.businessId, input.service_id);
      if (!service) throw new Error("Service not found");
      return service;
    },
    audit: true,
  },
  {
    name: "check_calendar",
    description: "Return REAL open appointment slots from the calendar provider (business hours minus bookings). Never invented (safety rule 2).",
    permissionLevel: "READ",
    inputSchema: z.object({
      service_id: uuid("service_id").nullable().optional(),
      duration_min: z.number().int().min(15).max(600).optional(),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      days: z.number().int().min(1).max(14).optional(),
      lead_id: uuid("lead_id").optional(),
    }),
    validate: async (ctx, input) => {
      if (input.service_id) {
        const bad = await validateServiceInBusiness(ctx, input.service_id);
        if (bad) return bad;
      }
      if (input.lead_id) {
        const bad = await validateLeadInBusiness(ctx, input.lead_id);
        if (bad) return bad;
      }
      return null;
    },
    handler: async (ctx, input) =>
      checkCalendarAction(ctx.businessId, {
        serviceId: input.service_id ?? null,
        durationMin: input.duration_min,
        startDate: input.start_date,
        days: input.days,
        leadId: input.lead_id,
      }),
    audit: true,
  },

  // ============================ WRITE =====================================
  {
    name: "create_lead",
    description: "Create a new lead for this business (the AI's only way to add a lead row).",
    permissionLevel: "WRITE",
    inputSchema: z.object({
      first_name: z.string().trim().min(1).max(100),
      last_name: z.string().trim().max(100).optional(),
      phone: z.string().trim().max(30).optional(),
      email: z.string().email().max(254).optional().or(z.literal("")),
      source: z.string().trim().max(60).optional(),
      service_requested: z.string().trim().max(120).optional(),
      location: z.string().trim().max(120).optional(),
      notes: z.string().trim().max(2000).optional(),
    }),
    validate: readOnly,
    handler: async (ctx, input) => {
      const lead = await repo.createLead({
        businessId: ctx.businessId,
        firstName: input.first_name,
        lastName: input.last_name ?? "",
        phone: input.phone ?? "",
        email: input.email ?? "",
        source: input.source ?? "ai",
        serviceRequested: input.service_requested ?? "",
        location: input.location ?? "",
        notes: input.notes ?? "",
      });
      // Spec §30 — the lead-created event drives the immediate AI welcome rule.
      if (lead) {
        await emitEvent({ type: "LEAD_CREATED", businessId: ctx.businessId, leadId: lead.id, payload: { source: lead.source, firstName: lead.firstName } });
      }
      return lead;
    },
    audit: true,
  },
  {
    name: "update_lead",
    description: "Update a lead's contact/service fields (name, phone, email, service, location, estimated value). Status, score, and opt-out have their own dedicated tools.",
    permissionLevel: "WRITE",
    inputSchema: z.object({
      lead_id: uuid("lead_id"),
      first_name: z.string().trim().min(1).max(100).optional(),
      last_name: z.string().trim().max(100).optional(),
      phone: z.string().trim().max(30).optional(),
      email: z.string().email().max(254).optional().or(z.literal("")),
      service_requested: z.string().trim().max(120).optional(),
      location: z.string().trim().max(120).optional(),
      estimated_value_cents: z.number().int().min(0).max(100_000_000).optional(),
    }),
    validate: async (ctx, input) => validateLeadInBusiness(ctx, input.lead_id),
    handler: async (ctx, input) => {
      const patch: Record<string, string | number> = {};
      if (input.first_name !== undefined) patch.firstName = input.first_name;
      if (input.last_name !== undefined) patch.lastName = input.last_name;
      if (input.phone !== undefined) patch.phone = input.phone;
      if (input.email !== undefined) patch.email = input.email;
      if (input.service_requested !== undefined) patch.serviceRequested = input.service_requested;
      if (input.location !== undefined) patch.location = input.location;
      if (input.estimated_value_cents !== undefined) patch.estimatedValueCents = input.estimated_value_cents;
      const updated = await repo.updateLead(ctx.businessId, input.lead_id, patch as never);
      if (!updated) throw new Error("Lead not found");
      // Spec §30 — lead updated (contact/service fields).
      await emitEvent({ type: "LEAD_UPDATED", businessId: ctx.businessId, leadId: input.lead_id, payload: { fields: Object.keys(patch) } });
      return updated;
    },
    audit: true,
  },
  {
    name: "set_lead_status",
    description: "Move a lead through the pipeline (contacted → qualified → appointment_booked → customer; lost/unqualified/needs_human via explicit actions). Never downgrades automatically.",
    permissionLevel: "WRITE",
    inputSchema: z.object({ lead_id: uuid("lead_id"), status: z.enum(["new", "contacted", "qualified", "appointment_booked", "customer", "lost", "unqualified", "needs_human"]) }),
    validate: async (ctx, input) => validateLeadInBusiness(ctx, input.lead_id),
    handler: async (ctx, input) => {
      const updated = await setStatusAction(ctx.businessId, input.lead_id, input.status as LeadStatus);
      if (!updated) throw new Error("Lead not found");
      return updated;
    },
    audit: true,
  },
  {
    name: "score_lead",
    description: "Score a lead with the 0–100 rubric (spec §9–11): urgency 0–25, service fit 0–20, location 0–20, purchase intent 0–20, appointment intent 0–15. Returns score, classification (HOT/WARM/COLD/UNQUALIFIED/HUMAN_REVIEW), reasoning summary, and recommended next action. Persists score_value + classification.",
    permissionLevel: "WRITE",
    inputSchema: z.object({
      lead_id: uuid("lead_id"),
      service: z.string().trim().max(120).nullable().optional(),
      location: z.string().trim().max(120).nullable().optional(),
      urgency: z.enum(["emergency", "urgent", "soon", "none"]),
      purchase_intent: z.enum(["ready", "strong", "researching", "low"]),
      appointment_intent: z.enum(["ready", "considering", "none"]),
      escalation: z.string().trim().max(200).nullable().optional(),
    }),
    validate: async (ctx, input) => validateLeadInBusiness(ctx, input.lead_id),
    handler: async (ctx, input) => {
      const lead = await repo.getLeadById(ctx.businessId, input.lead_id);
      if (!lead) throw new Error("Lead not found");
      const business = await repo.getBusinessById(ctx.businessId);
      const [services] = await Promise.all([repo.listServices(ctx.businessId)]);
      const serviceArea = safeJson<{ zipCodes: string[]; cities: string[] }>(business?.serviceAreaJson ?? null, { zipCodes: [], cities: [] });

      const serviceFit = serviceFitFor(input.service, services.map((s) => ({ name: s.name })));
      const verdict = serviceAreaVerdict(input.location?.trim() ?? "", serviceArea);
      const locationFit: LocationFit = verdict === "inside" ? "inside" : verdict === "outside" ? "outside" : "unknown";

      const result: LeadScoreResult = computeLeadScore({
        urgency: input.urgency as UrgencyLevel,
        serviceFit,
        locationFit,
        purchaseIntent: input.purchase_intent as PurchaseIntent,
        appointmentIntent: input.appointment_intent as AppointmentIntent,
        escalation: input.escalation,
      });

      // Persist: numeric score, full classification, and the display badge
      // (never downgraded — keeps the existing hot/warm/cold UI meaningful).
      const display = mergeDisplayScore((lead.score as LeadScore) || "cold", result.displayScore);
      await repo.updateLead(ctx.businessId, input.lead_id, {
        scoreValue: result.score,
        classification: result.classification,
        score: display,
      });
      // Spec §30 — scoring is a lead update (score/classification changed).
      await emitEvent({
        type: "LEAD_UPDATED",
        businessId: ctx.businessId,
        leadId: input.lead_id,
        payload: { score: result.score, classification: result.classification, displayScore: display },
      });

      return {
        lead_id: input.lead_id,
        score: result.score,
        classification: result.classification,
        display_score: display,
        components: result.components,
        reasoning_summary: result.reasoningSummary,
        recommended_next_action: result.recommendedNextAction,
      };
    },
    audit: true,
  },
  {
    name: "schedule_followup",
    description: "Start (or restart) the follow-up sequence for a lead — schedules step 1 per the business's config (spec §9). Idempotent.",
    permissionLevel: "WRITE",
    inputSchema: leadRefSchema,
    validate: async (ctx, input) => validateLeadInBusiness(ctx, input.lead_id),
    handler: async (ctx, input) => startSequence(ctx.businessId, input.lead_id),
    audit: true,
  },
  {
    name: "stop_followup",
    description: "Stop all pending follow-ups for a lead (stop rule: booked / opt-out / customer / manual / lost).",
    permissionLevel: "WRITE",
    inputSchema: leadRefSchema,
    validate: async (ctx, input) => validateLeadInBusiness(ctx, input.lead_id),
    handler: async (ctx, input) => ({ cancelled: await stopSequence(ctx.businessId, input.lead_id) }),
    audit: true,
  },
  {
    name: "opt_out",
    description: "Mark a lead opted out and cancel all pending automated follow-ups immediately (safety rule 6).",
    permissionLevel: "WRITE",
    inputSchema: z.object({ lead_id: uuid("lead_id"), channel: z.enum(["sms", "email", "all"]).optional() }),
    validate: async (ctx, input) => validateLeadInBusiness(ctx, input.lead_id),
    handler: async (ctx, input) => {
      await optOutLead(ctx.businessId, input.lead_id, input.channel ?? "all");
      return { ok: true };
    },
    audit: true,
  },
  {
    name: "book_appointment",
    description: "Book a REAL appointment slot (re-verified against the calendar provider at write time — never double-books, never invents). Sends confirmation, updates lead status, stops follow-ups.",
    permissionLevel: "WRITE",
    inputSchema: z.object({
      lead_id: uuid("lead_id"),
      service_id: uuid("service_id").nullable().optional(),
      start_at: z.number().int().positive(),
      notes: z.string().max(2000).optional(),
    }),
    validate: async (ctx, input) => {
      const badLead = await validateLeadInBusiness(ctx, input.lead_id);
      if (badLead) return badLead;
      if (input.service_id) {
        const badService = await validateServiceInBusiness(ctx, input.service_id);
        if (badService) return badService;
      }
      return null;
    },
    handler: async (ctx, input) =>
      bookAppointmentAction(ctx.businessId, { leadId: input.lead_id, serviceId: input.service_id ?? null, startAt: input.start_at, notes: input.notes }),
    audit: true,
  },
  {
    name: "send_message",
    description: "Append an AI/system message to a conversation thread. The AI's only way to speak to a customer through the channel.",
    permissionLevel: "WRITE",
    inputSchema: z.object({
      conversation_id: uuid("conversation_id"),
      body: z.string().trim().min(1).max(4000),
      sender: z.enum(["ai", "system"]).optional(),
    }),
    validate: async (ctx, input) =>
      (await repo.getConversationById(ctx.businessId, input.conversation_id)) ? null : `conversation ${input.conversation_id} does not belong to business ${ctx.businessId}`,
    handler: async (ctx, input) => {
      const id = await repo.addMessage(ctx.businessId, { conversationId: input.conversation_id, sender: input.sender ?? "ai", body: input.body });
      // Spec §30 — the AI/system spoke; the message-sent event is emitted from
      // the single send choke point (the send_message tool). The lead is
      // resolved from the conversation when the caller didn't pass it.
      const conv = await repo.getConversationById(ctx.businessId, input.conversation_id);
      await emitEvent({
        type: "MESSAGE_SENT",
        businessId: ctx.businessId,
        leadId: ctx.leadId ?? conv?.leadId ?? null,
        conversationId: input.conversation_id,
        payload: { messageId: id, sender: input.sender ?? "ai" },
      });
      return id;
    },
    audit: true,
  },
  {
    name: "send_followup",
    description: "Send a due follow-up message (SMS/email via the configured providers), mark the follow-up row sent, and advance the sequence (spec §9). Tenant-scoped — used by the automation engine.",
    permissionLevel: "WRITE",
    inputSchema: z.object({ follow_up_id: uuid("follow_up_id") }),
    validate: async (ctx, input) =>
      (await repo.getFollowUpById(ctx.businessId, input.follow_up_id)) ? null : `follow-up ${input.follow_up_id} does not belong to business ${ctx.businessId}`,
    handler: async (ctx, input) => sendFollowUpRow(ctx.businessId, input.follow_up_id),
    audit: true,
  },
  {
    name: "send_review_request",
    description: "Send the post-completed-job feedback request to a customer (SMS/email via the configured providers, spec §21) and open a review record. Only fires after JOB_COMPLETED; never pressures for a public review. Emits REVIEW_REQUESTED. Idempotent per appointment.",
    permissionLevel: "WRITE",
    inputSchema: z.object({ appointment_id: uuid("appointment_id") }),
    validate: async (ctx, input) =>
      (await repo.getAppointmentById(ctx.businessId, input.appointment_id)) ? null : `appointment ${input.appointment_id} does not belong to business ${ctx.businessId}`,
    handler: async (ctx, input) => requestReview(ctx.businessId, input.appointment_id),
    audit: true,
  },
  {
    name: "record_feedback",
    description: "Record a customer's feedback reply to a review request. Classifies sentiment (positive/negative/unknown). POSITIVE → sends the business's configured public review link. NEGATIVE → creates an internal customer-service human task and NEVER sends a public review link. UNKNOWN → stored, no further action. Idempotent per review.",
    permissionLevel: "WRITE",
    inputSchema: z.object({
      review_id: uuid("review_id"),
      feedback_text: z.string().trim().min(1).max(2000),
    }),
    validate: async (ctx, input) =>
      (await repo.getReviewById(ctx.businessId, input.review_id)) ? null : `review ${input.review_id} does not belong to business ${ctx.businessId}`,
    handler: async (ctx, input) => recordFeedback(ctx.businessId, input.review_id, input.feedback_text),
    audit: true,
  },
  {
    name: "create_human_task",
    description: "Create a human escalation task (priority, lead_id, reason, conversation_summary, recommended_action — spec §18) + owner notification. Used by the Human Escalation Manager and the permission gate.",
    permissionLevel: "WRITE",
    inputSchema: z.object({
      lead_id: uuid("lead_id").optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]),
      reason: z.string().trim().min(1).max(500),
      conversation_summary: z.string().trim().max(2000).optional(),
      recommended_action: z.string().trim().max(500).optional(),
    }),
    validate: async (ctx, input) => {
      if (input.lead_id) return validateLeadInBusiness(ctx, input.lead_id);
      return null;
    },
    handler: async (ctx, input) =>
      createHumanTaskRecord(ctx.businessId, {
        leadId: input.lead_id,
        priority: input.priority as HumanTaskPriority,
        reason: input.reason,
        conversationSummary: input.conversation_summary,
        recommendedAction: input.recommended_action,
      }),
    audit: true,
  },

  {
    name: "record_usage",
    description:
      "Record a deterministic usage/cost event for this business (ai_message | sms | voice, spec §32). " +
      "Called after every AI reply and SMS send; the handler also fires deduped 80/90/100% budget alerts. " +
      "Tenant-scoped by the calling business; audited like every tool.",
    permissionLevel: "WRITE",
    inputSchema: z.object({
      kind: z.enum(["ai_message", "sms", "voice"]),
      direction: z.enum(["inbound", "outbound"]),
      input_tokens: z.number().int().min(0),
      output_tokens: z.number().int().min(0),
      estimated_cost_cents: z.number().int().min(0),
      meta: z.record(z.string(), z.unknown()).optional(),
    }),
    validate: async (ctx) => (await repo.getBusinessById(ctx.businessId)) ? null : `business ${ctx.businessId} not found`,
    handler: async (ctx, input) => {
      await repo.recordUsageEvent(ctx.businessId, {
        kind: input.kind,
        direction: input.direction,
        inputTokens: input.input_tokens,
        outputTokens: input.output_tokens,
        estimatedCostCents: input.estimated_cost_cents,
        meta: input.meta,
      });
      // Budget alerts fire here — the single choke point for every usage event.
      await checkBudgetAlerts(ctx.businessId);
      return { ok: true };
    },
    audit: true,
  },

  // ====================== HIGH_RISK (declared, AI-forbidden) ==============
  {
    name: "cancel_appointment",
    description: "Cancel an existing appointment. HIGH RISK — requires human approval; the AI is never granted this tool (spec §24).",
    permissionLevel: "HIGH_RISK",
    inputSchema: z.object({ appointment_id: uuid("appointment_id") }),
    validate: async (ctx, input) =>
      (await repo.getAppointmentById(ctx.businessId, input.appointment_id)) ? null : `appointment ${input.appointment_id} does not belong to business ${ctx.businessId}`,
    handler: async (ctx, input) => updateAppointmentStatusAction(ctx.businessId, { appointmentId: input.appointment_id, status: "cancelled" }),
    audit: true,
  },
  {
    name: "refund",
    description: "Process a refund. HIGH RISK — requires human approval; the AI is never granted this tool.",
    permissionLevel: "HIGH_RISK",
    inputSchema: z.object({ lead_id: uuid("lead_id"), amount_cents: z.number().int().min(0).optional(), reason: z.string().trim().max(500).optional() }),
    validate: async (ctx, input) => validateLeadInBusiness(ctx, input.lead_id),
    handler: async () => {
      throw new Error("refund requires human approval and is not available to the AI");
    },
    audit: true,
  },
  {
    name: "change_billing",
    description: "Change billing/subscription details. HIGH RISK — requires human approval; the AI is never granted this tool.",
    permissionLevel: "HIGH_RISK",
    inputSchema: z.object({ plan: z.enum(["starter", "professional", "premium"]).optional(), reason: z.string().trim().max(500).optional() }),
    validate: readOnly,
    handler: async () => {
      throw new Error("billing changes require human approval and are not available to the AI");
    },
    audit: true,
  },
  {
    name: "modify_sensitive_data",
    description: "Modify sensitive lead/business data (PII, notes, internal fields). HIGH RISK — requires human approval; the AI is never granted this tool.",
    permissionLevel: "HIGH_RISK",
    inputSchema: z.object({ lead_id: uuid("lead_id"), fields: z.array(z.string()).max(20).optional() }),
    validate: async (ctx, input) => validateLeadInBusiness(ctx, input.lead_id),
    handler: async () => {
      throw new Error("sensitive data modifications require human approval and are not available to the AI");
    },
    audit: true,
  },
];

// ---------------------------------------------------------------------------
// Registry access
// ---------------------------------------------------------------------------

export function getTool(name: string): ToolDef | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}

/** Tools the AI may call (READ + WRITE). HIGH_RISK is excluded by construction. */
export const AI_ACCESSIBLE_TOOLS: readonly string[] = TOOL_REGISTRY.filter((t) => t.permissionLevel !== "HIGH_RISK").map((t) => t.name);

/** Tools whose handler failure is critical enough to create a human task (§31). */
const CRITICAL_TOOLS = new Set(["book_appointment", "send_message", "schedule_followup", "opt_out", "send_review_request", "record_feedback"]);

// ---------------------------------------------------------------------------
// callTool — the ONE entry point (spec §24: validation → permission → handler
// → audit; §31: never silent, retry-safe ops, human task on critical failure).
// ---------------------------------------------------------------------------

export interface CallToolOptions {
  toolName: string;
  ctx: ToolContext;
  input: unknown;
  caller: ToolCaller;
}

export async function callTool(opts: CallToolOptions): Promise<unknown> {
  const { ctx, caller } = opts;
  const tool = getTool(opts.toolName);
  const leadId = await resolveAuditLeadId(ctx, opts.input);

  if (!tool) {
    await writeAudit(ctx, { action: opts.toolName, leadId, input: opts.input, result: { error: "unknown-tool" }, success: false });
    throw new ToolError("unknown_tool", `Unknown tool: ${opts.toolName}`);
  }

  // 1) Input validation (zod) — runs first, always.
  const parsed = tool.inputSchema.safeParse(opts.input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    await writeAudit(ctx, {
      action: tool.name,
      leadId,
      input: opts.input,
      result: { error: "invalid-input", path: issue?.path.join(".") ?? "", message: issue?.message ?? "invalid" },
      success: false,
    });
    throw new ToolError("invalid_input", `Invalid input for ${tool.name}: ${issue?.message ?? "validation failed"}`);
  }

  // 2) Permission gate — the AI can NEVER call HIGH_RISK tools (spec §24–25).
  if (tool.permissionLevel === "HIGH_RISK" && caller === "ai") {
    await writeAudit(ctx, {
      action: tool.name,
      leadId,
      input: parsed.data,
      result: { rejected: true, reason: "high-risk-forbidden", caller: "ai" },
      success: false,
    });
    await createHumanTaskRecord(ctx.businessId, {
      leadId,
      priority: "high",
      reason: `HIGH_RISK tool '${tool.name}' was attempted by the AI and blocked.`,
      conversationSummary: `AI agent '${ctx.agent}' attempted to call ${tool.name}${ctx.conversationId ? ` in conversation ${ctx.conversationId}` : ""}.`,
      recommendedAction: "A human must perform this action manually — nothing was changed by the AI.",
    });
    throw new ToolError("permission_denied", `Tool '${tool.name}' is HIGH_RISK and not available to the AI.`);
  }

  // 3) Tenant + business-rule validation (spec §33 isolation).
  const rejectReason = await tool.validate(ctx, parsed.data);
  if (rejectReason) {
    await writeAudit(ctx, { action: tool.name, leadId, input: parsed.data, result: { rejected: true, reason: rejectReason }, success: false });
    throw new ToolError("tenant_mismatch", `${tool.name} rejected: ${rejectReason}`);
  }

  // 4) Handler + audit. Safe (READ) ops retry once on transient failure (§31);
  // failures are never silent; critical failures raise a human task.
  let lastError: unknown;
  for (let attempt = 0; attempt <= (tool.permissionLevel === "READ" ? 1 : 0); attempt++) {
    try {
      const result = await tool.handler(ctx, parsed.data);
      if (tool.audit) {
        // create_lead returns the new row — carry its id onto the audit row
        // (only when no lead id was already resolved).
        const resultLeadId =
          typeof result === "object" && result !== null && UUID_RE.test(String((result as Record<string, unknown>).id ?? ""));
        await writeAudit(ctx, {
          action: tool.name,
          leadId: leadId ?? (resultLeadId ? String((result as Record<string, unknown>).id) : undefined),
          input: parsed.data,
          result: { ...(result as object) },
          success: true,
        });
      }
      return result;
    } catch (e) {
      lastError = e;
      if (attempt === 0) continue; // retry safe ops once
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  await writeAudit(ctx, { action: tool.name, leadId, input: parsed.data, result: { error: message }, success: false });
  if (CRITICAL_TOOLS.has(tool.name)) {
    await createHumanTaskRecord(ctx.businessId, {
      leadId,
      priority: "high",
      reason: `AI tool '${tool.name}' failed: ${message.slice(0, 200)}`,
      conversationSummary: `Agent '${ctx.agent}' attempted ${tool.name}${ctx.conversationId ? ` in conversation ${ctx.conversationId}` : ""}.`,
      recommendedAction: "Follow up with the customer directly to complete what the AI could not.",
    });
  }
  throw new ToolError("handler_failed", `${tool.name} failed: ${message}`);
}

/** AI convenience: call a tool with the AI caller (HIGH_RISK is always rejected). */
export async function callAiTool(toolName: string, ctx: ToolContext, input: unknown): Promise<unknown> {
  return callTool({ toolName, ctx, input, caller: "ai" });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Service fit: exact name → 20, token/family overlap → 10, nothing → 0 (spec §10). */
function serviceFitFor(service: string | null | undefined, services: { name: string }[]): ServiceFit {
  const sv = (service ?? "").trim().toLowerCase();
  if (!sv) return "unknown";
  const names = services.map((s) => s.name.toLowerCase());
  if (names.includes(sv)) return "exact";
  const svToks = new Set(sv.split(/[^a-z0-9]+/).filter((t) => t.length > 1));
  for (const n of names) {
    const nToks = new Set(n.split(/[^a-z0-9]+/).filter((t) => t.length > 1));
    let hits = 0;
    for (const t of svToks) if (nToks.has(t)) hits += 1;
    if (hits >= 1) return "related";
  }
  return "not_offered";
}

/** Re-export the area verdict type for tests/introspection. */
export type { AreaVerdict, LeadClassification };
