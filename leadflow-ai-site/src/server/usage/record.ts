/**
 * AI BRAIN 5a — SMS usage recording (spec §32).
 *
 * Every SMS send records a deterministic usage event through the tool
 * registry (audited, tenant-scoped): kind=sms, direction=outbound, a
 * deterministic token count for the body, and SMS_COST_CENTS as the
 * estimated cost. The record_usage handler fires the 80/90/100% budget
 * alerts, so SMS sends count toward the same monthly budget as AI replies.
 */
import { callAiTool } from "../ai/tools/registry";
import { estimateTokens } from "../integrations/ai";
import { SMS_COST_CENTS } from "./budget";

export async function recordSmsUsage(opts: {
  businessId: string;
  leadId?: string | null;
  agent: string;
  conversationId?: string;
  body: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await callAiTool(
      "record_usage",
      { businessId: opts.businessId, agent: opts.agent, conversationId: opts.conversationId, leadId: opts.leadId ?? undefined },
      {
        kind: "sms",
        direction: "outbound",
        input_tokens: 0,
        output_tokens: estimateTokens(opts.body),
        estimated_cost_cents: SMS_COST_CENTS,
        meta: { ...(opts.meta ?? {}), chars: opts.body.length },
      }
    );
  } catch (e) {
    // Usage recording must never break a send (spec §31).
    console.error(`[usage] record_sms failed for ${opts.agent}:`, e);
  }
}
