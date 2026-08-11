/**
 * Lead status transitions (spec §9) — shared by the qualification engine and
 * the tool registry's `set_lead_status` tool.
 *
 * Pipeline order: new → contacted → qualified → appointment_booked →
 * customer; lost/unqualified/needs_human are terminal-ish states reached only
 * by explicit actions (human decisions or escalation).
 *
 * Rule: never downgrade a pipeline status the lead has already reached, except
 * for the explicit terminal states (lost / unqualified / needs_human), which
 * callers pass through intentionally.
 */
import * as repo from "../db/repo";
import type { LeadStatus } from "../db/schema";
import { emitEvent } from "./events";

const STATUS_ORDER: LeadStatus[] = ["new", "contacted", "qualified", "appointment_booked", "customer", "lost", "unqualified", "needs_human"];
const EXPLICIT_TERMINAL: LeadStatus[] = ["lost", "unqualified", "needs_human"];

export async function setStatusAction(
  businessId: string,
  leadId: string,
  status: LeadStatus
): Promise<NonNullable<Awaited<ReturnType<typeof repo.getLeadById>>> | null> {
  const lead = await repo.getLeadById(businessId, leadId);
  if (!lead) return null;
  const cur = STATUS_ORDER.indexOf(lead.status);
  const next = STATUS_ORDER.indexOf(status);
  if (cur >= 0 && next >= 0 && next < cur && !EXPLICIT_TERMINAL.includes(status)) return lead;
  const updated = await repo.updateLead(businessId, leadId, { status });
  if (updated) {
    await repo.logAgentAction(businessId, {
      agent: "qualification",
      action: "set_status",
      leadId,
      input: { status },
      result: { ok: true },
      success: true,
    });
    // Spec §30: the qualification event — the follow-up sequence (and anything
    // else) subscribes to it. Emitted on the single status choke point so the
    // AI and human routes behave identically. Other status changes are covered
    // by the specific events (APPOINTMENT_BOOKED, JOB_COMPLETED, …).
    if (status === "qualified") {
      await emitEvent({ type: "LEAD_QUALIFIED", businessId, leadId, payload: { status, previousStatus: lead.status } });
    }
  }
  return updated;
}
