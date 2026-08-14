/**
 * SUPPORT TASK CATEGORIZATION (Phase 2 / Chunk F — dogfooding automation #7).
 *
 * A deterministic, no-LLM keyword classifier in the style of
 * `classifySentiment` + `wordHits` in `reviews/agent.ts`. Categories a human
 * escalation task (`human_tasks`) from its `reason` + `conversation_summary` +
 * `recommended_action` fields.
 *
 * Categories: billing | technical | emergency | complaint | other
 * Precedence:  emergency > billing > complaint > technical > other
 *   (an "emergency billing" task is EMERGENCY; a "complaint about an invoice"
 *    is BILLING because billing outranks complaint; "angry about the widget
 *    being broken" is COMPLAINT because complaint outranks technical.)
 *
 * Wired as the WRITE tool `categorize_human_task` in `ai/tools/registry.ts`,
 * fired by the default `support_ticket_categorization` rule on
 * HUMAN_ESCALATION → the task is categorized and the owner is notified with
 * the category (kind `support_ticket_categorized`).
 */
import * as repo from "../db/repo";

export type TaskCategory = "billing" | "technical" | "emergency" | "complaint" | "other";
export const TASK_CATEGORIES: TaskCategory[] = ["billing", "technical", "emergency", "complaint", "other"];

/** Emergency — safety / time-critical (wins over every other category). */
export const EMERGENCY_WORDS = [
  "emergency", "urgent", "asap", "immediately", "right away",
  "burst", "bursting", "flood", "flooding", "gas leak", "water leak", "leak", "leaking",
  "no heat", "no cooling", "no ac", "no power", "power outage",
  "fire", "smoke", "sewage", "backed up", "backed-up",
  "dangerous", "safety", "unsafe", "injured", "injury", "carbon monoxide",
  "can't wait", "cannot wait", "tonight", "overnight",
];
/** Billing — money / invoices / pricing (second precedence). */
export const BILLING_WORDS = [
  "billing", "bill", "invoice", "invoiced", "charged", "charge", "refund", "payment", "paying", "paid",
  "price", "pricing", "quote", "quoted", "cost", "costs", "overcharged", "overcharge", "double-charged",
  "subscription", "fee", "fees", "credit card", "chargeback", "discount", "deposit",
  "money", "charged twice", "billed twice",
];
/** Complaint — customer dissatisfaction / service quality (third precedence). */
export const COMPLAINT_WORDS = [
  "complaint", "complaining", "complained", "unhappy", "angry", "upset", "furious", "terrible", "awful", "worst",
  "horrible", "rude", "unprofessional", "disappointed", "dissatisfied", "unacceptable", "sloppy",
  "damage", "damaged", "waste", "never again", "terrible service", "bad service", "poor service",
  "liar", "lied", "scam", "ripped off", "no show", "no-show", "late", "took forever",
];
/** Technical — product/platform malfunction or configuration (fourth precedence). */
export const TECHNICAL_WORDS = [
  "error", "not working", "doesn't work", "does not work", "isn't working", "is not working", "won't work", "wont work",
  "broken", "broke", "bug", "glitch", "crash", "crashes", "crashing", "failed", "failing", "failure",
  "issue", "problem", "unavailable", "down", "won't load", "wont load", "not loading", "won't send", "not sending",
  "install", "installation", "configure", "configuration", "setup", "integration", "api", "widget",
  "sync", "syncing", "connection", "disconnected", "disconnect", "login", "password", "unable to",
  "doesn't show", "does not show", "missing", "blank", "stuck", "hangs", "hanging",
];

function wordHits(text: string, words: string[]): number {
  const lower = ` ${text.toLowerCase()} `;
  let hits = 0;
  for (const w of words) {
    const re = new RegExp(`[^a-z]${w}[^a-z]`, "g");
    const m = lower.match(re);
    if (m) hits += m.length;
  }
  return hits;
}

/** Concatenated classification text: reason + conversation summary + recommended action. */
export function taskText(reason: string, conversationSummary: string, recommendedAction: string): string {
  return `${reason ?? ""}\n${conversationSummary ?? ""}\n${recommendedAction ?? ""}`.trim();
}

/**
 * Deterministic category for a human escalation task.
 * Precedence: emergency > billing > complaint > technical > other.
 * Empty input → "other".
 */
export function classifyTaskCategory(reason: string, conversationSummary = "", recommendedAction = ""): TaskCategory {
  const text = taskText(reason, conversationSummary, recommendedAction);
  if (!text) return "other";
  if (wordHits(text, EMERGENCY_WORDS) > 0) return "emergency";
  if (wordHits(text, BILLING_WORDS) > 0) return "billing";
  if (wordHits(text, COMPLAINT_WORDS) > 0) return "complaint";
  if (wordHits(text, TECHNICAL_WORDS) > 0) return "technical";
  return "other";
}

export interface CategorizeResult {
  humanTaskId: string;
  category: TaskCategory;
}

/**
 * Categorize a human escalation task + notify the business owner with the
 * category. Wired as the `categorize_human_task` WRITE tool (validated,
 * tenant-scoped, audited) and fired by the `support_ticket_categorization`
 * default rule on HUMAN_ESCALATION.
 */
export async function categorizeHumanTask(businessId: string, humanTaskId: string): Promise<CategorizeResult> {
  const task = await repo.getHumanTaskById(businessId, humanTaskId);
  if (!task) throw new Error(`human task ${humanTaskId} not found for business ${businessId}`);
  const category = classifyTaskCategory(task.reason, task.conversationSummary, task.recommendedAction);
  await repo.updateHumanTaskCategory(businessId, humanTaskId, category);
  await repo.createNotification(businessId, {
    kind: "support_ticket_categorized",
    title: `Support task categorized — ${category}`,
    body: `${task.reason.slice(0, 160)} — auto-categorized as ${category}.`,
  });
  return { humanTaskId, category };
}
