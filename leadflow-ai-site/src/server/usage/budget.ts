/**
 * AI BRAIN 5a — usage budget & alerts (spec §32 cost control).
 *
 * Every usage event (AI reply, SMS send, future voice call) is written through
 * the record_usage tool. This module turns those events into owner-facing
 * protections:
 *
 *   - checkBudgetAlerts(): after every recorded event, compare the business's
 *     current-month usage against its configured monthly budget and create an
 *     owner notification at 80% / 90% / 100%. Dedupe: one notification per
 *     threshold per business per month (kind = usage_alert_<pct>).
 *
 *   - usageBudgetExhausted(): the runaway-stop gate. Once estimated cost is at
 *     or over the budget, the chat engine pauses AI auto-responding (new
 *     conversations start human-held; inbound messages are held for a human)
 *     until the month rolls over or the owner raises the budget. The owner can
 *     always raise the budget in the AI Agents page — raising it clears the
 *     exhausted state immediately because the gate is computed from
 *     usage vs budget, never a stored flag.
 *
 *   - SMS_COST_CENTS: deterministic per-SMS cost estimate (Twilio-class, ~$0.008
 *     rounded to 1 cent) so SMS usage counts toward the same budget without
 *     real provider keys.
 */
import * as repo from "../db/repo";

/** Fixed deterministic estimated cost per SMS (documented in the PR). */
export const SMS_COST_CENTS = 1;
export const BUDGET_ALERT_PCTS = [80, 90, 100] as const;

/** Owner-facing view: current-month usage vs budget (spec §32). */
export interface BudgetStatus {
  monthStart: number;
  monthEnd: number;
  usage: repo.MonthlyUsage;
  budgetCents: number;
  /** 0–100+; how much of the monthly budget has been consumed. */
  percentUsed: number;
  exhausted: boolean;
  alerts: { threshold: number; reached: boolean }[];
}

export async function getBudgetStatus(businessId: string): Promise<BudgetStatus> {
  const monthStart = repo.usageMonthStartMs();
  const monthEnd = repo.usageMonthEndMs(monthStart);
  const [config, usage] = await Promise.all([repo.getAiConfig(businessId), repo.getMonthlyUsage(businessId)]);
  const budgetCents = config.monthlyBudgetCents > 0 ? config.monthlyBudgetCents : 0;
  const percentUsed = budgetCents > 0 ? (usage.estimatedCostCents / budgetCents) * 100 : 0;
  return {
    monthStart,
    monthEnd,
    usage,
    budgetCents,
    percentUsed,
    exhausted: budgetCents > 0 && usage.estimatedCostCents >= budgetCents,
    alerts: BUDGET_ALERT_PCTS.map((t) => ({ threshold: t, reached: percentUsed >= t })),
  };
}

/**
 * Fire deduped owner notifications at 80/90/100% of the monthly budget.
 * Called automatically after every usage event (from the record_usage tool
 * handler) and on the owner-facing usage view, so a threshold is reported the
 * moment it is crossed — and never spammed (kind is unique per threshold per
 * month).
 */
export async function checkBudgetAlerts(businessId: string): Promise<void> {
  const status = await getBudgetStatus(businessId);
  if (status.budgetCents <= 0) return; // no budget configured → no alerts
  const monthStart = status.monthStart;
  const money = status.usage.estimatedCostCents / 100;
  for (const t of BUDGET_ALERT_PCTS) {
    if (status.percentUsed < t) continue;
    const kind = `usage_alert_${t}`;
    const already = await repo.hasNotificationSince(businessId, kind, monthStart);
    if (already) continue;
    const title =
      t === 100
        ? "AI usage budget reached — AI auto-respond is paused"
        : `AI usage at ${t}% of the monthly budget`;
    const body =
      t === 100
        ? `This month's estimated AI + SMS usage ($${money.toFixed(2)}) has reached your $${(status.budgetCents / 100).toFixed(2)} budget. New conversations now start human-held to prevent runaway costs — raise the budget on the AI Agents page to resume AI auto-respond.`
        : `Estimated AI + SMS usage is $${money.toFixed(2)} of your $${(status.budgetCents / 100).toFixed(2)} monthly budget. Raise or review it on the AI Agents page.`;
    await repo.createNotification(businessId, { kind, title, body });
  }
}

/** Runaway-stop gate: true once usage is at/over the budget (spec §32). */
export async function usageBudgetExhausted(businessId: string): Promise<boolean> {
  const status = await getBudgetStatus(businessId);
  return status.exhausted;
}
