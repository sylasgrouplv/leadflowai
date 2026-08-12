/**
 * Automation rule definitions (spec §29) — AI BRAIN 3 + 4.
 *
 * Rules are per-business and idempotent: `ensureDefaultRulesForBusiness`
 * creates the wiring the product ships with (event → condition → action):
 *
 *   1. LEAD_CREATED          → send_welcome            (immediate AI welcome)
 *   2. LEAD_QUALIFIED        → lead_not_booked         → start_followup_sequence
 *                            (the 1/3/7/14-day sequence IS the "delayed"
 *                            behavior — each step is a persisted run)
 *   3. APPOINTMENT_BOOKED    → cancel_followups        (existing stop rule)
 *   4. JOB_COMPLETED         → send_review_request     (AI BRAIN 4 — Review
 *                            Agent, spec §21; delayed by the business's
 *                            configured review delay, default 1 day)
 *   5. APPOINTMENT_BOOKED    → schedule_appointment_reminder (dogfooding
 *                            Phase 1b — schedules a reminder at appointment
 *                            start minus the business's lead time, default
 *                            120 minutes; re-checks the appointment at fire
 *                            time; never reminds cancelled/rescheduled ones)
 *
 * `ensureDefaultRulesForBusiness` is NAME-based (not count-based): businesses
 * that predate a new default rule pick it up on the next scheduler tick
 * without touching their existing rules. REVIEW_REQUESTED is emitted by the
 * Review Agent when a feedback request is sent (spec §30).
 */
import * as repo from "../db/repo";

export const DEFAULT_RULE_NAMES = ["lead_created_welcome", "qualified_followup_sequence", "appointment_confirmation", "job_completed_review", "appointment_reminder"] as const;
export type DefaultRuleName = (typeof DEFAULT_RULE_NAMES)[number];

export interface DefaultRuleSpec {
  name: DefaultRuleName;
  triggerEvent: repo.AutomationRuleInput["triggerEvent"];
  delayMs: number;
  condition: unknown;
  action: string;
  actionConfig: unknown;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RULES: DefaultRuleSpec[] = [
  {
    name: "lead_created_welcome",
    triggerEvent: "LEAD_CREATED",
    delayMs: 0,
    condition: { type: "none" },
    action: "send_welcome",
    actionConfig: {},
  },
  {
    name: "qualified_followup_sequence",
    triggerEvent: "LEAD_QUALIFIED",
    delayMs: 0,
    condition: { type: "lead_not_booked" },
    action: "start_followup_sequence",
    actionConfig: {},
  },
  {
    name: "appointment_confirmation",
    triggerEvent: "APPOINTMENT_BOOKED",
    delayMs: 0,
    condition: { type: "none" },
    action: "cancel_followups",
    actionConfig: {},
  },
  {
    name: "job_completed_review",
    triggerEvent: "JOB_COMPLETED",
    // delayMs is per-business from review_configs (default 1 day); the rule is
    // (re)created with the current config and kept in sync by saveReviewConfig.
    delayMs: 0,
    condition: { type: "none" },
    action: "send_review_request",
    actionConfig: {},
  },
  {
    name: "appointment_reminder",
    triggerEvent: "APPOINTMENT_BOOKED",
    // delayMs 0: the action computes the reminder offset from the appointment's
    // startAt (start minus `reminder_minutes`, default 120). Per-business lead
    // time lives in this rule's actionConfig (config-only, no schema change).
    delayMs: 0,
    condition: { type: "none" },
    action: "schedule_appointment_reminder",
    actionConfig: { reminder_minutes: 120 },
  },
];

/** The review rule's delay from the business's review config (default 1 day). */
export async function reviewRuleDelayMs(businessId: string): Promise<number> {
  const config = await repo.getReviewConfig(businessId);
  return config.delayDays * DAY_MS;
}

/**
 * Create the default rules for a business if it has none (idempotent).
 * Name-based: existing businesses get any newly-added default rule without
 * their current rules being touched or duplicated.
 */
export async function ensureDefaultRulesForBusiness(businessId: string): Promise<boolean> {
  const existing = await repo.listAutomationRules(businessId);
  const names = new Set(existing.map((r) => r.name));
  let created = false;
  for (const spec of DEFAULT_RULES) {
    if (names.has(spec.name)) continue;
    const delayMs = spec.name === "job_completed_review" ? await reviewRuleDelayMs(businessId) : spec.delayMs;
    await repo.createAutomationRule(businessId, {
      name: spec.name,
      triggerEvent: spec.triggerEvent,
      delayMs,
      condition: spec.condition,
      action: spec.action,
      actionConfig: spec.actionConfig,
    });
    created = true;
  }
  return created;
}

/** Keep the review rule's delay in sync with the business's review config. */
export async function syncReviewRuleDelay(businessId: string): Promise<void> {
  const rules = await repo.listAutomationRules(businessId);
  const rule = rules.find((r) => r.name === "job_completed_review");
  if (!rule) {
    await ensureDefaultRulesForBusiness(businessId);
    return;
  }
  const delayMs = await reviewRuleDelayMs(businessId);
  if (rule.delayMs !== delayMs) await repo.updateAutomationRule(businessId, rule.id, { delayMs });
}

/** Ensure defaults for every business (called on each scheduler tick — cheap). */
export async function ensureDefaultRulesForAllBusinesses(): Promise<number> {
  const ids = await repo.listAllBusinessIds();
  let created = 0;
  for (const id of ids) {
    if (await ensureDefaultRulesForBusiness(id)) created += 1;
  }
  return created;
}
