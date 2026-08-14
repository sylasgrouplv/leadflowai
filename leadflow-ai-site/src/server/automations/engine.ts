/**
 * AUTOMATION ENGINE WORKER (spec §29 + §31) — AI BRAIN 3.
 *
 * One worker pass (runs on the existing scheduler interval, every ~60s):
 *   1. backfill — any pending follow_up row without a run gets one (the
 *      safety net for pre-Brain-3 rows and rows created outside the engine),
 *   2. ensure default rules exist per business (idempotent),
 *   3. recover stale `running` rows (a process died mid-run): retry with
 *      backoff, or fail when attempts are exhausted,
 *   4. pick due pending runs (persisted — delayed/scheduled runs survive
 *      restarts) and for each:
 *        claim → resolve the rule's action → evaluate the condition AT FIRE
 *        TIME → (follow-up step runs re-check the row is still pending — stop
 *        rules) → execute the action THROUGH THE TOOL REGISTRY (validated +
 *        audited) → record the outcome.
 *
 * Error handling (spec §31 — never silent): failures are logged with agent /
 * action / lead / error / timestamp / retry_count; safe ops retry with
 * backoff up to MAX_ATTEMPTS; critical failures create a human task.
 */
import * as repo from "../db/repo";
import { emitEvent } from "../ai/events";
import { evaluateCondition } from "./conditions";
import { executeAction, ENGINE_CRITICAL_ACTIONS } from "./actions";
import { ensureDefaultRulesForAllBusinesses } from "./rules";
import { callAiTool } from "../ai/tools/registry";

export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 60_000;

export interface EngineRunSummary {
  checked: number;
  executed: number;
  done: number;
  cancelled: number;
  failed: number;
  retried: number;
  errors: number;
  backfilled: number;
}

function backoffMs(attempt: number): number {
  return BACKOFF_MS * 2 ** (attempt - 1);
}

function stepNumber(templateKey: string | null): number | null {
  const m = /^seq_(\d+)$/.exec(templateKey ?? "");
  return m ? Number(m[1]) : null;
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Create a run for every pending follow_up row that doesn't have one yet. */
export async function backfillFollowUpRuns(limit = 500): Promise<number> {
  const pending = await repo.listPendingFollowUps(limit);
  let created = 0;
  for (const f of pending) {
    const existing = await repo.getRunForFollowUp(f.id);
    if (existing) continue;
    await repo.createAutomationRun({
      businessId: f.businessId,
      leadId: f.leadId,
      ruleKind: "followup_step_send",
      runAt: f.scheduledFor,
      payload: { followUpId: f.id, step: stepNumber(f.templateKey), templateKey: f.templateKey ?? "", type: f.type },
    });
    created += 1;
  }
  return created;
}

async function logRunError(run: { businessId: string; leadId: string | null; id: string; ruleKind: string }, message: string, attempts: number) {
  await repo.logAgentAction(run.businessId, {
    agent: "automation",
    action: "run_error",
    leadId: run.leadId ?? undefined,
    input: { runId: run.id, ruleKind: run.ruleKind, attempts },
    result: { error: message.slice(0, 300) },
    success: false,
  });
}

/** §31: critical failures raise a human task so a person completes the step. */
async function createCriticalTask(run: { businessId: string; leadId: string | null }, action: string, message: string) {
  try {
    await callAiTool(
      "create_human_task",
      { businessId: run.businessId, agent: "automation", leadId: run.leadId ?? undefined },
      {
        lead_id: run.leadId ?? undefined,
        priority: "high",
        reason: `Automation action '${action}' failed after retries: ${message.slice(0, 200)}`,
        recommended_action: "Complete this step manually — the automated action did not succeed.",
      }
    );
  } catch (e) {
    console.error("[automation] critical task creation failed:", e);
  }
}

async function handleFailure(run: { businessId: string; leadId: string | null; id: string; ruleKind: string; attempts: number }, action: string, message: string, nowMs: number, summary: EngineRunSummary) {
  const attempts = run.attempts + 1;
  await logRunError(run, message, attempts);
  if (attempts < MAX_ATTEMPTS) {
    await repo.updateAutomationRun(run.businessId, run.id, { status: "pending", attempts, lastError: message.slice(0, 500), runAt: nowMs + backoffMs(attempts) });
    summary.retried += 1;
  } else {
    await repo.updateAutomationRun(run.businessId, run.id, { status: "failed", attempts, lastError: message.slice(0, 500) });
    summary.failed += 1;
    if (ENGINE_CRITICAL_ACTIONS.has(action)) {
      await createCriticalTask(run, action, message);
    }
  }
}

export async function runAutomationEngine(nowMs = Date.now()): Promise<EngineRunSummary> {
  const summary: EngineRunSummary = { checked: 0, executed: 0, done: 0, cancelled: 0, failed: 0, retried: 0, errors: 0, backfilled: 0 };

  // 1) Backfill + defaults (never block the tick on a rules failure).
  try {
    summary.backfilled = await backfillFollowUpRuns();
  } catch (e) {
    summary.errors += 1;
    console.error("[automation] backfill failed:", e);
  }
  try {
    await ensureDefaultRulesForAllBusinesses();
  } catch (e) {
    console.error("[automation] ensure default rules failed:", e);
  }

  // 3) Stale `running` rows (crash mid-run) — retry or fail.
  try {
    for (const r of await repo.listStuckAutomationRuns(50)) {
      summary.checked += 1;
      if (r.attempts >= MAX_ATTEMPTS) {
        await repo.updateAutomationRun(r.businessId, r.id, { status: "failed", lastError: r.lastError || "interrupted" });
        summary.failed += 1;
      } else {
        await repo.updateAutomationRun(r.businessId, r.id, { status: "pending", runAt: nowMs + backoffMs(r.attempts + 1) });
        summary.retried += 1;
      }
    }
  } catch (e) {
    summary.errors += 1;
    console.error("[automation] stuck-run recovery failed:", e);
  }

  // 4) Due runs.
  const due = await repo.listDueAutomationRuns(100, nowMs);
  for (const run of due) {
    summary.checked += 1;
    await repo.updateAutomationRun(run.businessId, run.id, { status: "running" });
    try {
      // Resolve the action: the rule row is authoritative; follow-up step runs
      // carry their action in ruleKind + payload.
      let action: string;
      let actionConfig: unknown;
      let conditionJson = "{}";
      if (run.ruleId) {
        const rule = await repo.getAutomationRuleById(run.businessId, run.ruleId);
        if (!rule || rule.enabled !== 1) {
          await repo.updateAutomationRun(run.businessId, run.id, { status: "cancelled", lastError: rule ? "rule-disabled" : "rule-deleted" });
          summary.cancelled += 1;
          continue;
        }
        action = rule.action;
        actionConfig = safeJson(rule.actionConfigJson, {});
        conditionJson = rule.conditionJson;
      } else {
        action = run.ruleKind === "followup_step_send" ? "send_followup" : run.ruleKind;
        actionConfig = safeJson(run.payloadJson, {});
      }

      // Condition evaluated at fire time — a run whose condition no longer
      // holds is cancelled (never executed).
      const verdict = await evaluateCondition(run.businessId, run.leadId, conditionJson);
      if (!verdict.pass) {
        await repo.updateAutomationRun(run.businessId, run.id, { status: "cancelled", lastError: `condition:${verdict.reason ?? "failed"}` });
        summary.cancelled += 1;
        continue;
      }

      // Follow-up step runs (the sequence): the row must still be pending
      // (stop rules: booked / customer / opt-out / manual stop all cancel the
      // row first). Rule-driven send_followup runs skip this pre-check — they
      // go to the tool and fail loudly (§31: validated + retried + human task
      // on critical failure) instead of being silently cancelled.
      if (action === "send_followup") {
        const payload = safeJson(run.payloadJson, {}) as Record<string, unknown>;
        const cfg = (actionConfig ?? {}) as Record<string, unknown>;
        const followUpId = typeof payload.followUpId === "string" ? payload.followUpId : typeof cfg.followUpId === "string" ? cfg.followUpId : "";
        if (run.ruleId === null) {
          const row = followUpId ? await repo.getFollowUpById(run.businessId, followUpId) : null;
          if (!row || row.status !== "pending") {
            await repo.updateAutomationRun(run.businessId, run.id, { status: "cancelled", lastError: row ? `followup-${row.status}` : "followup-missing" });
            summary.cancelled += 1;
            continue;
          }
          await emitEvent({
            type: "FOLLOWUP_DUE",
            businessId: run.businessId,
            leadId: run.leadId,
            payload: { followUpId, runId: run.id, ruleKind: run.ruleKind },
          });
        }
      }

      // Review requests (Brain 4): the appointment id lives in the
      // JOB_COMPLETED event payload captured on the run — forward it into the
      // action config so the send_review_request action can call the tool.
      if (action === "send_review_request") {
        const payload = safeJson(run.payloadJson, {}) as Record<string, unknown>;
        const cfg = (actionConfig ?? {}) as Record<string, unknown>;
        const appointmentId = payload.appointmentId ?? payload.appointment_id ?? cfg.appointment_id ?? cfg.appointmentId ?? "";
        actionConfig = { ...cfg, appointment_id: appointmentId };
      }

      // Appointment reminders (Phase 1b — Chunk D): the appointment id lives
      // in the APPOINTMENT_BOOKED event payload captured on the run — forward
      // it so the schedule_appointment_reminder action can schedule the
      // reminder (idempotent; re-checked at send time).
      if (action === "schedule_appointment_reminder") {
        const payload = safeJson(run.payloadJson, {}) as Record<string, unknown>;
        const cfg = (actionConfig ?? {}) as Record<string, unknown>;
        const appointmentId = payload.appointmentId ?? payload.appointment_id ?? cfg.appointment_id ?? cfg.appointmentId ?? "";
        actionConfig = { ...cfg, appointment_id: appointmentId };
      }
      // Support task categorization (Phase 2 — Chunk F): the human task id
      // lives in the HUMAN_ESCALATION event payload captured on the run
      // (createHumanTaskRecord emits { taskId, priority, reason }) — forward
      // it so the categorize_human_task action can call the tool.
      if (action === "categorize_human_task") {
        const payload = safeJson(run.payloadJson, {}) as Record<string, unknown>;
        const cfg = (actionConfig ?? {}) as Record<string, unknown>;
        const taskId = payload.taskId ?? payload.task_id ?? cfg.human_task_id ?? cfg.taskId ?? "";
        actionConfig = { ...cfg, human_task_id: taskId };
      }

      const res = await executeAction({ businessId: run.businessId, leadId: run.leadId, action, actionConfig });
      if (res.ok) {
        await repo.updateAutomationRun(run.businessId, run.id, { status: "done", attempts: run.attempts + 1, lastError: "" });
        summary.done += 1;
        summary.executed += 1;
      } else {
        await handleFailure(run, action, res.error ?? "unknown-error", nowMs, summary);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await handleFailure(run, run.ruleKind === "followup_step_send" ? "send_followup" : run.ruleKind, message, nowMs, summary);
    }
  }
  return summary;
}
