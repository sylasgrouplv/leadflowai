/**
 * Automation conditions (spec §29) — evaluated AT FIRE TIME, not at rule
 * creation. A run whose condition no longer holds is cancelled (never sent):
 * "lead not booked", "score >= 50", etc.
 */
import * as repo from "../db/repo";

export type RunCondition =
  | { type: "none" }
  | { type: "lead_not_booked" }
  | { type: "score_gte"; value: number }
  | { type: "lead_status_in"; statuses: string[] }
  | { type: "has_phone" }
  | { type: "has_email" };

export function parseCondition(json: string): RunCondition {
  try {
    const raw = JSON.parse(json || "{}") as Partial<RunCondition> & { value?: number; statuses?: string[] };
    if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return { type: "none" };
    if (raw.type === "score_gte") return { type: "score_gte", value: typeof raw.value === "number" ? raw.value : 50 };
    if (raw.type === "lead_status_in") return { type: "lead_status_in", statuses: Array.isArray(raw.statuses) ? raw.statuses : [] };
    if (["none", "lead_not_booked", "has_phone", "has_email"].includes(raw.type)) return raw as RunCondition;
    return { type: "none" };
  } catch {
    return { type: "none" };
  }
}

export interface ConditionVerdict {
  pass: boolean;
  reason: string | null;
}

export async function evaluateCondition(businessId: string, leadId: string | null, conditionJson: string): Promise<ConditionVerdict> {
  const cond = parseCondition(conditionJson);
  if (cond.type === "none") return { pass: true, reason: null };

  const lead = leadId ? await repo.getLeadById(businessId, leadId) : null;
  if (!lead) return { pass: false, reason: "no-lead" };

  switch (cond.type) {
    case "lead_not_booked":
      return lead.optedOut === 1
        ? { pass: false, reason: "opted-out" }
        : ["appointment_booked", "customer"].includes(lead.status)
          ? { pass: false, reason: `lead-${lead.status}` }
          : { pass: true, reason: null };
    case "score_gte":
      return lead.scoreValue >= cond.value ? { pass: true, reason: null } : { pass: false, reason: `score-${lead.scoreValue}-lt-${cond.value}` };
    case "lead_status_in":
      return cond.statuses.includes(lead.status) ? { pass: true, reason: null } : { pass: false, reason: `status-${lead.status}` };
    case "has_phone":
      return lead.phone ? { pass: true, reason: null } : { pass: false, reason: "no-phone" };
    case "has_email":
      return lead.email ? { pass: true, reason: null } : { pass: false, reason: "no-email" };
    default:
      return { pass: true, reason: null };
  }
}
