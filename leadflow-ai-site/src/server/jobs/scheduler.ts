/**
 * Background jobs for the Bun server.
 *
 * Automation engine scheduler (AI BRAIN 3): every AUTOMATION_INTERVAL_MS
 * (default 60s, env-tunable) the engine picks due persisted runs, evaluates
 * conditions at fire time, and executes actions through the tool registry —
 * including the follow-up sequence (rebuilt onto the engine: every follow-up
 * step is a run; stop rules cancel rows + runs; send failures retry with
 * backoff and critical failures create a human task).
 *
 * Weekly business-intelligence reports (AI BRAIN 4, spec §22): on the same
 * tick, once a week has fully ended (Monday 00:00 UTC + a 1h settle window),
 * the previous week's report is generated for every business that doesn't
 * have one yet. The check is cheap (one indexed lookup per business) and
 * idempotent, so missed ticks are harmless.
 *
 * Limits (MVP, single process):
 *   - the interval lives in one server process; the published site is a single
 *     Bun server, so this is fine today. On a multi-instance deployment it must
 *     move to a shared queue/cron (e.g. pg_cron / a worker) to avoid duplicate
 *     execution — runs are claimed (pending → running) before work, which
 *     reduces the window but is not lock-protected.
 *   - missed ticks are fine: the scheduler catches up on the next tick (due
 *     runs are picked by run_at <= now; weekly reports are created when the
 *     week is past + settle window).
 *   - if the server restarts, due runs simply fire on the next tick — the run
 *     store is persisted (spec §29).
 */
import { runAutomationEngine } from "../automations/engine";
import { runWeeklyReportJob } from "../bi/report";
import { runDailyOpsReportJob } from "../bi/outreach";

const INTERVAL_MS = Number(process.env.AUTOMATION_INTERVAL_MS || process.env.FOLLOWUP_INTERVAL_MS || 60_000);

let started = false;

export function startSchedulers(): void {
  if (started) return;
  started = true;

  const tick = async () => {
    try {
      const run = await runAutomationEngine();
      if (run.executed || run.cancelled || run.failed || run.retried || run.backfilled || run.errors) {
        console.log(
          `[scheduler] automation: checked=${run.checked} executed=${run.executed} done=${run.done} cancelled=${run.cancelled} failed=${run.failed} retried=${run.retried} backfilled=${run.backfilled} errors=${run.errors}`
        );
      }
    } catch (e) {
      console.error("[scheduler] automation run failed:", e);
    }
    try {
      const made = await runWeeklyReportJob();
      if (made > 0) console.log(`[scheduler] weekly reports generated for ${made} business(es)`);
    } catch (e) {
      console.error("[scheduler] weekly report run failed:", e);
    }
    try {
      const made = await runDailyOpsReportJob();
      if (made > 0) console.log(`[scheduler] daily ops reports generated for ${made} business(es)`);
    } catch (e) {
      console.error("[scheduler] daily ops report run failed:", e);
    }
  };

  // First pass shortly after boot, then on the interval.
  setTimeout(tick, 5_000);
  const handle = setInterval(tick, INTERVAL_MS);
  if (typeof handle.unref === "function") handle.unref();
}
