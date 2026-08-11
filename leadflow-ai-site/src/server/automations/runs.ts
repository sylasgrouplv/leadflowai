/**
 * Follow-up run scheduling helpers — AI BRAIN 3.
 *
 * Every follow_up row is backed by an automation_run (ruleKind
 * "followup_step_send", run_at = the step's scheduledFor). The automation
 * worker picks due runs and executes the send through the registry's
 * send_followup tool — so the follow-up sequence IS an automation path
 * (spec §29), with one persisted scheduling layer for everything.
 */
import * as repo from "../db/repo";

function stepNumber(templateKey: string | null): number | null {
  const m = /^seq_(\d+)$/.exec(templateKey ?? "");
  return m ? Number(m[1]) : null;
}

export interface FollowUpRunSpec {
  leadId: string;
  followUpId: string;
  scheduledFor: number;
  templateKey: string;
  type: string;
}

export async function createFollowUpStepRun(businessId: string, spec: FollowUpRunSpec) {
  return repo.createAutomationRun({
    businessId,
    leadId: spec.leadId,
    ruleKind: "followup_step_send",
    runAt: spec.scheduledFor,
    payload: { followUpId: spec.followUpId, step: stepNumber(spec.templateKey), templateKey: spec.templateKey, type: spec.type },
  });
}
