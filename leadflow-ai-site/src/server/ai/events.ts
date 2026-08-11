/**
 * EVENT SYSTEM (spec §30) — AI BRAIN 3.
 *
 * The internal event bus. Every meaningful domain change emits an event:
 *
 *   LEAD_CREATED, LEAD_UPDATED, MESSAGE_RECEIVED, MESSAGE_SENT, LEAD_QUALIFIED,
 *   APPOINTMENT_REQUESTED, APPOINTMENT_BOOKED, APPOINTMENT_CANCELLED,
 *   JOB_COMPLETED, FOLLOWUP_DUE, FOLLOWUP_SENT, CUSTOMER_OPTED_OUT,
 *   HUMAN_ESCALATION, REVIEW_REQUESTED
 *
 * Events carry type + business_id (tenant isolation, spec §33) + lead_id /
 * conversation_id when applicable + payload + timestamp. Each event is:
 *   1. PERSISTED (events table) — observability / audit / analytics,
 *   2. DISPATCHED to the automation engine — every enabled rule subscribed to
 *      that event has a run row materialized (run_at = now + delay_ms). The
 *      worker picks due runs on its next tick; immediate rules fire on the
 *      next tick, delayed rules after their delay. Runs are the persisted
 *      scheduling layer, so nothing is lost on restart.
 *
 * Emission points (single mutation choke points):
 *   - tool registry handlers  (create_lead, update_lead, score_lead,
 *     set_lead_status, send_message, send_followup, book_appointment,
 *     cancel_appointment via the appointment action, opt_out)
 *   - shared action functions (setStatusAction, bookAppointmentAction,
 *     updateAppointmentStatusAction, optOutLead, createHumanTaskRecord) so the
 *     human routes emit exactly the same events as the AI path
 *   - chat engine               (MESSAGE_RECEIVED, APPOINTMENT_REQUESTED)
 *   - automation worker         (FOLLOWUP_DUE before a follow-up sends)
 *
 * REVIEW_REQUESTED is declared here and emitted by the Review Agent — that
 * agent is Brain 4; the event type is part of the bus now so Brain 4 only
 * adds an emitter.
 */
import * as repo from "../db/repo";
import type { EventType } from "../db/schema";
import { ensureDefaultRulesForBusiness, DEFAULT_RULE_NAMES } from "../automations/rules";

export type { EventType };
export const EVENT_TYPES = [
  "LEAD_CREATED",
  "LEAD_UPDATED",
  "MESSAGE_RECEIVED",
  "MESSAGE_SENT",
  "LEAD_QUALIFIED",
  "APPOINTMENT_REQUESTED",
  "APPOINTMENT_BOOKED",
  "APPOINTMENT_CANCELLED",
  "JOB_COMPLETED",
  "FOLLOWUP_DUE",
  "FOLLOWUP_SENT",
  "CUSTOMER_OPTED_OUT",
  "HUMAN_ESCALATION",
  "REVIEW_REQUESTED",
] as const;

export interface EmitEventInput {
  type: EventType;
  businessId: string;
  leadId?: string | null;
  conversationId?: string | null;
  payload?: unknown;
  /** Override the timestamp (tests force events into the past). */
  createdAt?: number;
}

export interface EmittedEvent {
  id: string;
  type: EventType;
  businessId: string;
  leadId: string | null;
  conversationId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

/**
 * Emit an event: persist it, then materialize a run for every enabled rule
 * subscribed to this event type (spec §29: "Agents subscribe to events").
 * Returns the persisted event row.
 */
export async function emitEvent(input: EmitEventInput): Promise<EmittedEvent> {
  const { type, businessId, leadId = null, conversationId = null, payload = {}, createdAt } = input;

  // Default rules are per-business and idempotent — created lazily so events
  // always have subscribers without a migration/seed dependency.
  await ensureDefaultRulesForBusiness(businessId);

  const id = await repo.createEvent({ businessId, type, leadId, conversationId, payload, createdAt });
  const row = { id, type, businessId, leadId, conversationId, payload: payload as Record<string, unknown>, createdAt: createdAt ?? repo.now() };

  // Dispatch: materialize runs for matching rules (synchronously — runs are
  // visible to tests and the worker immediately).
  try {
    const rules = await repo.getAutomationRulesForEvent(businessId, type);
    for (const rule of rules) {
      await repo.createAutomationRun({
        businessId,
        leadId,
        ruleId: rule.id,
        ruleKind: rule.name,
        runAt: repo.now() + rule.delayMs,
        payload: { event: type, leadId, conversationId, ...(payload as object) },
      });
    }
  } catch (e) {
    // The event itself is persisted; a dispatch failure must never break the
    // mutation that emitted it (the worker also backfills on each tick).
    console.error("[events] dispatch failed for", type, e);
  }
  return row;
}

/** Observability: recent events for a business (event log surface). */
export async function listEvents(businessId: string, limit = 100): Promise<EmittedEvent[]> {
  const rows = await repo.listEvents(businessId, { limit });
  return rows.map((r) => ({ id: r.id, type: r.type, businessId: r.businessId, leadId: r.leadId, conversationId: r.conversationId, payload: safeJson(r.payloadJson, {}), createdAt: r.createdAt }));
}

/** Test/observability helper: did this business emit the event since `since`? */
export async function eventEmitted(businessId: string, type: EventType, since?: number, leadId?: string): Promise<boolean> {
  const rows = await repo.listEvents(businessId, { types: [type], since, limit: 100 });
  return rows.some((r) => (leadId ? r.leadId === leadId : true));
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export { DEFAULT_RULE_NAMES };
