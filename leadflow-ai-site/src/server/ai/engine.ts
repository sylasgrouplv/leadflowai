/**
 * Chat engine — orchestrates conversations between leads, the AI receptionist,
 * and humans.
 *
 * Every AI mutation goes through the FORMAL TOOL REGISTRY (spec §24–25) —
 * validated, tenant-scoped, audit-logged. The AI never touches the database
 * directly (spec §42: DB = source of truth, tools = action layer). Humans
 * write through the routes below (which use the same validated actions).
 */
import * as repo from "../db/repo";
import { getAiProvider } from "../integrations";
import { usageBudgetExhausted } from "../usage/budget";
import { orchestrate } from "./orchestrator";
import { qualifyLead, setStatusAction, scoreLeadAction, type LeadRow } from "./qualify";
import type { LeadScore, LeadStatus } from "../db/schema";
import { callAiTool } from "./tools/registry";
import { emitEvent } from "./events";
import { fmtTime } from "../appointments/agent";
import { optOutLead, startSequence } from "../followups/engine";
import { isAgentEnabled } from "../platform/settings";

export type ConversationBundle = {
  conversation: NonNullable<Awaited<ReturnType<typeof repo.getConversationById>>>;
  lead: LeadRow | null;
  messages: Awaited<ReturnType<typeof repo.listMessages>>;
  appointments: Awaited<ReturnType<typeof repo.listAppointmentsForLead>>;
  nextFollowUp: { scheduledFor: number; type: string } | null;
  ai: {
    name: string;
    active: boolean;
    status: string;
    heldByHuman: boolean;
  };
};

export async function getBundle(businessId: string, conversationId: string): Promise<ConversationBundle | null> {
  const conversation = await repo.getConversationById(businessId, conversationId);
  if (!conversation) return null;
  const [lead, messages, appointments] = await Promise.all([
    conversation.leadId ? repo.getLeadById(businessId, conversation.leadId) : Promise.resolve(null),
    repo.listMessages(businessId, conversationId),
    conversation.leadId ? repo.listAppointmentsForLead(businessId, conversation.leadId) : Promise.resolve([]),
  ]);
  const fups = conversation.leadId ? await repo.getNextFollowUps(businessId) : new Map<string, { scheduledFor: number; type: string }>();
  const nextFollowUp = conversation.leadId ? fups.get(conversation.leadId) ?? null : null;
  const aiConfig = await repo.getAiConfig(businessId);
  return {
    conversation,
    lead,
    messages,
    appointments,
    nextFollowUp,
    ai: {
      // Spec §38 — the chat UI shows the owner-configured agent name.
      name: aiConfig.agentName,
      active: conversation.aiEnabled === 1,
      status: conversation.status,
      heldByHuman: conversation.status === "human_takeover",
    },
  };
}

const DEFAULT_WELCOME =
  "Hi! Thanks for reaching out — I'm the AI receptionist. How can we help today? Tell me what you need and a little about your situation.";

/** Create a conversation for a lead (or create a lead first when leadId is null). */
export async function startConversation(
  businessId: string,
  opts: { leadId?: string; channel?: string; source?: string; welcome?: boolean; testLeadName?: string }
): Promise<ConversationBundle> {
  let leadId = opts.leadId ?? null;
  if (!leadId) {
    // AI mutation path — through the tool registry (create_lead: validated + audited).
    const lead = (await callAiTool("create_lead", { businessId, agent: "receptionist" }, {
      first_name: opts.testLeadName ?? "New",
      last_name: opts.testLeadName ? "" : "Visitor",
      source: opts.source ?? "manual",
      notes: opts.source === "website_chat" ? "Created by website chat" : "Created via Test AI chat",
    })) as Awaited<ReturnType<typeof repo.createLead>>;
    if (!lead) throw new Error("Could not create lead");
    leadId = lead.id;
  }

  const existing = await repo.listConversations(businessId, { leadIds: leadId ? [leadId] : [] });
  const active = existing.find((c) => c.conversation.status !== "closed");
  let conversation;
  // autoRespond (owner AI config): when off, new conversations start
  // human-held — the AI neither welcomes nor auto-replies until returned.
  // Spec §39: the global receptionist switch (platform admin) gates the same
  // way — when disabled, no business's AI receptionist welcomes or replies.
  const aiConfig = await repo.getAiConfig(businessId);
  const receptionistEnabled = await isAgentEnabled("receptionist");
  const autoRespond = aiConfig.autoRespond && receptionistEnabled;
  if (active) {
    conversation = active.conversation;
  } else {
    conversation = await repo.createConversation(businessId, {
      leadId: leadId ?? undefined,
      channel: opts.channel ?? "chat",
      status: autoRespond ? "ai_handling" : "active",
      aiEnabled: autoRespond ? 1 : 0,
    });
  }

  // Spec §32 runaway-stop: when the monthly usage budget is exhausted the AI
  // does not welcome new conversations — they start human-held so costs can't
  // run away until the owner raises the budget (or the month rolls over).
  const budgetExhausted = await usageBudgetExhausted(businessId);

  // AI welcome message (skipped when auto-respond is off — the AI stays quiet
  // until a human hands the conversation back).
  if (opts.welcome !== false && autoRespond && !budgetExhausted) {
    const business = await repo.getBusinessById(businessId);
    let welcome = DEFAULT_WELCOME;
    if (business) {
      try {
        const policies = JSON.parse(business.policiesJson || "{}");
        if (policies.welcomeMessage) welcome = policies.welcomeMessage;
      } catch {
        /* keep default */
      }
    }
    await callAiTool("send_message", { businessId, agent: "receptionist", conversationId: conversation.id }, { conversation_id: conversation.id, body: welcome });
  } else if (budgetExhausted && autoRespond) {
    // Hold the conversation for a human and say so in the thread.
    await repo.updateConversation(businessId, conversation.id, { aiEnabled: 0, status: "active" });
    await callAiTool("send_message", { businessId, agent: "system", conversationId: conversation.id }, {
      conversation_id: conversation.id,
      sender: "system",
      body: "AI responses are paused — this business has reached its monthly AI usage budget. New conversations start human-held until the budget is raised (AI Agents page) or the month resets.",
    });
  } else if (!receptionistEnabled) {
    // Spec §39 — the platform admin disabled the receptionist agent globally.
    // New conversations start human-held, with a visible note (never silent).
    await repo.updateConversation(businessId, conversation.id, { aiEnabled: 0, status: "active" });
    await callAiTool("send_message", { businessId, agent: "system", conversationId: conversation.id }, {
      conversation_id: conversation.id,
      sender: "system",
      body: "The AI receptionist is currently disabled by the platform. A team member will take it from here.",
    });
  }

  const bundle = await getBundle(businessId, conversation.id);
  if (!bundle) throw new Error("Conversation could not be loaded");
  return bundle;
}

/** Handle an incoming lead message: persist, qualify, AI-respond, escalate. */
export async function handleLeadMessage(businessId: string, conversationId: string, body: string): Promise<ConversationBundle> {
  const conversation = await repo.getConversationById(businessId, conversationId);
  if (!conversation) throw new Error("Conversation not found");
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Message cannot be empty");

  await repo.addMessage(businessId, { conversationId, sender: "lead", body: trimmed });
  let lead = conversation.leadId ? await repo.getLeadById(businessId, conversation.leadId) : null;
  // Spec §30 — a customer message arrived (message choke point: every inbound
  // channel flows through handleLeadMessage).
  await emitEvent({
    type: "MESSAGE_RECEIVED",
    businessId,
    leadId: lead?.id ?? null,
    conversationId,
    payload: { channel: conversation.channel, body: trimmed.slice(0, 500) },
  });

  // Opt-out stop rule (spec §9 + safety rule 6): "stop"/"unsubscribe" in chat
  // stops follow-ups immediately — no further automated messages.
  if (lead && OPT_OUT_RE.test(trimmed)) {
    try {
      await callAiTool("opt_out", { businessId, agent: "receptionist", conversationId }, { lead_id: lead.id, channel: "all" });
    } catch (e) {
      console.error("[engine] opt_out failed:", e);
      await optOutLead(businessId, lead.id, "all"); // belt and braces — never fail the stop rule
    }
    await callAiTool("send_message", { businessId, agent: "receptionist", conversationId }, {
      conversation_id: conversationId,
      body: "You're all set — we'll stop sending follow-up messages. If you change your mind, just reply and we'll help. (This is the AI receptionist.)",
    });
    await repo.updateLead(businessId, lead.id, { lastContactedAt: repo.now() });
    const b = await getBundle(businessId, conversationId);
    if (!b) throw new Error("Conversation could not be loaded");
    return b;
  }

  // AI BRAIN 4 — Review Agent reply channel (spec §21): when a feedback
  // request is open for this lead (review request sent, no feedback yet), the
  // customer's reply IS the feedback — record it (positive → review link /
  // negative → human task, never pressure) and reply with the outcome.
  if (lead) {
    const openReview = await repo.getOpenReviewForLead(businessId, lead.id);
    if (openReview) {
      let outcomeText = "";
      try {
        const res = (await callAiTool(
          "record_feedback",
          { businessId, agent: "review", conversationId, leadId: lead.id },
          { review_id: openReview.id, feedback_text: trimmed }
        )) as { message?: string };
        outcomeText = res.message ?? "Thanks for your feedback.";
      } catch (e) {
        console.error("[engine] record_feedback failed:", e);
        outcomeText = "Thanks for your feedback — we've passed it along.";
      }
      await callAiTool("send_message", { businessId, agent: "review", conversationId }, { conversation_id: conversationId, body: outcomeText });
      await repo.updateLead(businessId, lead.id, { lastContactedAt: repo.now() });
      const fb = await getBundle(businessId, conversationId);
      if (!fb) throw new Error("Conversation could not be loaded");
      return fb;
    }
  }
  if (conversation.aiEnabled === 1) {
    // Spec §32 runaway-stop: once the monthly usage budget is exhausted the AI
    // stops auto-responding — the conversation is held for a human and the
    // owner was already notified at 100% (deduped). Raising the budget on the
    // AI Agents page clears the gate immediately (it is computed, not stored).
    if (await usageBudgetExhausted(businessId)) {
      await repo.updateConversation(businessId, conversationId, { aiEnabled: 0, status: "active" });
      try {
        await callAiTool("send_message", { businessId, agent: "system", conversationId }, {
          conversation_id: conversationId,
          sender: "system",
          body: "AI responses are paused — this business has reached its monthly AI usage budget. A team member will take it from here (raise the budget on the AI Agents page to resume).",
        });
      } catch (e) {
        console.error("[engine] budget-pause note failed:", e);
      }
      if (lead) await repo.updateLead(businessId, lead.id, { lastContactedAt: repo.now() });
      const bb = await getBundle(businessId, conversationId);
      if (!bb) throw new Error("Conversation could not be loaded");
      return bb;
    }
    // Qualification first so the AI reply can be grounded in fresh lead data.
    if (lead) {
      const q = await qualifyLead(businessId, lead, trimmed);
      lead = q.lead;
      // Trigger event for the follow-up sequence (spec §9): lead qualified.
      if (q.changed.includes("status") && lead?.status === "qualified") {
        await startSequence(businessId, lead.id);
      }
    }

    // AI Agent Brain: every message flows through the orchestrator —
    // intent detection → business context + memory → agent routing →
    // escalation/tool decisions → KB-grounded reply. The provider (mock
    // today, real LLM later) is reached ONLY through the provider interface.
    const outcome = await orchestrate({ businessId, conversationId, message: trimmed, lead });
    let reply = outcome.reply;
    // Booking intent -> offer REAL times from the calendar (never invented):
    // the Appointment Agent supplies slots, the AI just presents them.
    if (outcome.needsAvailability && lead) {
      // Spec §30 — the customer asked for an appointment (booking flow start).
      await emitEvent({
        type: "APPOINTMENT_REQUESTED",
        businessId,
        leadId: lead.id,
        conversationId,
        payload: { intent: outcome.intent, message: trimmed.slice(0, 500) },
      });
      reply = await offerRealAvailability(businessId, lead, reply, conversationId);
    }
    await callAiTool("send_message", { businessId, agent: outcome.agent.id, conversationId }, { conversation_id: conversationId, body: reply });

    // Escalation: flag for humans, stop auto-responding, notify the team.
    if (outcome.escalate && lead) {
      // Spec §39 — the escalation agent switch. Safety-critical triggers
      // (emergency, direct human request, cancel/refund/legal/angry) ALWAYS
      // escalate regardless of the switch; softer triggers (complaint, owner
      // keyword, low-confidence unknown) are suppressed when the admin
      // disabled the escalation agent — never silently (audit row + log).
      const reason = outcome.escalationReason ?? "";
      const ALWAYS_ESCALATE = ["emergency", "human-request", "high-risk-action-cancel", "angry-or-legal", "refund-request"];
      const escalationEnabled = await isAgentEnabled("escalation");
      if (!escalationEnabled && !ALWAYS_ESCALATE.includes(reason)) {
        await repo.logAgentAction(businessId, {
          agent: "escalation",
          action: "escalation_suppressed",
          leadId: lead.id,
          input: { reason },
          result: { suppressed: true, reason: "escalation-agent-disabled" },
          success: false,
        });
        console.warn(`[engine] escalation suppressed (agent disabled) for ${businessId}: ${reason}`);
      } else {
        const priority = reason === "emergency" ? "urgent" : ["complaint", "refund-request", "high-risk-action-cancel", "angry-or-legal"].includes(reason) ? "high" : "medium";
        await callAiTool("set_lead_status", { businessId, agent: "escalation", conversationId }, { lead_id: lead.id, status: "needs_human" });
        await callAiTool("create_human_task", { businessId, agent: "escalation", conversationId }, {
          lead_id: lead.id,
          priority,
          reason,
          conversation_summary: `Lead ${lead.firstName} ${lead.lastName ?? ""} (${lead.serviceRequested || "no service"}). Last message: "${trimmed.slice(0, 300)}". AI reply: "${reply.slice(0, 200)}".`,
          recommended_action: "Review the conversation and respond personally; do not let the AI continue unattended.",
        });
        await repo.updateConversation(businessId, conversationId, { aiEnabled: 0, status: "human_takeover" });
      }
    } else if (lead) {
      // Keep status flowing: an engaged, fully-collected lead is qualified.
      await repo.updateLead(businessId, lead.id, { lastContactedAt: repo.now() });
    }
  } else if (lead) {
    await repo.updateLead(businessId, lead.id, { lastContactedAt: repo.now() });
  }

  const bundle = await getBundle(businessId, conversationId);
  if (!bundle) throw new Error("Conversation could not be loaded");
  return bundle;
}

const OPT_OUT_RE = /^(stop|unsubscribe|opt\s*out|no\s+more\s+(texts|messages|follow[\s-]*ups)|please\s+stop)\b/i;

/**
 * When the AI detects booking intent, append the next real open slots from the
 * calendar provider (business hours minus bookings minus busy blocks). If no
 * service is known yet, fall back to the business's first active service.
 *
 * Calendar failure (spec §12–14 + §31): when the calendar cannot be reached the
 * AI NEVER claims a booking and NEVER invents times — the customer is told the
 * scheduling system is unavailable, the request is handed to the team as a
 * human task (priority medium), and the failed check_calendar is already
 * audit-logged by the tool registry (never silent).
 */
async function offerRealAvailability(businessId: string, lead: LeadRow, reply: string, conversationId?: string): Promise<string> {
  try {
    const services = await repo.listServices(businessId);
    if (!services.length) return reply;
    const service =
      services.find((s) => s.name.toLowerCase() === (lead.serviceRequested ?? "").toLowerCase()) ??
      services.find((s) => s.active === 1) ??
      services[0];
    // Real calendar availability — via the tool registry (check_calendar: READ,
    // validated + audited; slots come ONLY from the calendar provider).
    const days = (await callAiTool("check_calendar", { businessId, agent: "appointment", conversationId }, {
      service_id: service.id,
      duration_min: service.durationMin,
      days: 3,
      lead_id: lead.id,
    })) as { date: string; slots: { startAt: number; endAt: number }[] }[];
    if (!days.length) {
      return `${reply}\n\nI checked our calendar — I'm not seeing open times in the next few days, but I can have someone call you, or tell me a date and I'll check again.`;
    }
    const lines: string[] = [];
    for (const d of days.slice(0, 3)) {
      const times = d.slots.slice(0, 4).map((s) => fmtTime(s.startAt)).join(", ");
      lines.push(`${d.date}: ${times}`);
    }
    return `${reply}\n\nHere are the next open times I can offer (${service.name}):\n${lines.join("\n")}\n\nWhich one works for you?`;
  } catch (e) {
    // Spec §12–14: never claim booked, never invent times — say it plainly and
    // hand the follow-up to the team (employee contacts the customer, §31).
    console.error(`[engine] calendar availability failed for ${businessId}:`, e);
    try {
      await callAiTool(
        "create_human_task",
        { businessId, agent: "appointment", conversationId, leadId: lead.id },
        {
          lead_id: lead.id,
          priority: "medium",
          reason: "calendar-failure",
          conversation_summary: `Customer requested an appointment but the scheduling system could not be reached (${(e as Error)?.message ?? "provider error"}). Lead ${lead.firstName} ${lead.lastName ?? ""}${lead.serviceRequested ? ` — ${lead.serviceRequested}` : ""}.`,
          recommended_action: "Contact the customer and confirm an appointment time manually.",
        }
      );
    } catch (taskErr) {
      // The human task is best-effort on top of the audited tool failure —
      // never break the conversation over it.
      console.error("[engine] calendar-failure human task failed:", taskErr);
    }
    return `${reply}\n\nI'm having trouble accessing the scheduling system right now. I've sent this to the team so they can confirm your appointment.`;
  }
}

/** Human reply — marks the conversation as human-held. */
export async function humanReply(businessId: string, conversationId: string, body: string): Promise<ConversationBundle> {
  const conversation = await repo.getConversationById(businessId, conversationId);
  if (!conversation) throw new Error("Conversation not found");
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Message cannot be empty");
  await repo.addMessage(businessId, { conversationId, sender: "employee", body: trimmed });
  await repo.updateConversation(businessId, conversationId, { status: "human_takeover", aiEnabled: 0 });
  if (conversation.leadId) {
    const lead = await repo.getLeadById(businessId, conversation.leadId);
    if (lead) await repo.updateLead(businessId, lead.id, { lastContactedAt: repo.now() });
  }
  const bundle = await getBundle(businessId, conversationId);
  if (!bundle) throw new Error("Conversation could not be loaded");
  return bundle;
}

/** Human takes over: AI stops auto-responding until returned. */
export async function takeOver(businessId: string, conversationId: string): Promise<ConversationBundle> {
  await repo.updateConversation(businessId, conversationId, { aiEnabled: 0, status: "human_takeover" });
  const bundle = await getBundle(businessId, conversationId);
  if (!bundle) throw new Error("Conversation could not be loaded");
  return bundle;
}

/** Return control to the AI receptionist. */
export async function returnToAi(businessId: string, conversationId: string): Promise<ConversationBundle> {
  await repo.updateConversation(businessId, conversationId, { aiEnabled: 1, status: "active" });
  const bundle = await getBundle(businessId, conversationId);
  if (!bundle) throw new Error("Conversation could not be loaded");
  return bundle;
}

/** Mark the conversation's lead qualified (validated action + log). */
export async function markQualified(businessId: string, conversationId: string, score: LeadScore = "warm"): Promise<ConversationBundle> {
  const conversation = await repo.getConversationById(businessId, conversationId);
  if (!conversation || !conversation.leadId) throw new Error("Conversation has no lead");
  await scoreLeadAction(businessId, conversation.leadId, score);
  await setStatusAction(businessId, conversation.leadId, "qualified");
  // Qualified = follow-up sequence trigger event (spec §9).
  await startSequence(businessId, conversation.leadId);
  const bundle = await getBundle(businessId, conversationId);
  if (!bundle) throw new Error("Conversation could not be loaded");
  return bundle;
}

/** Close the lead: outcome lost | unqualified | customer. */
export async function closeLead(businessId: string, conversationId: string, outcome: LeadStatus): Promise<ConversationBundle> {
  if (!["lost", "unqualified", "customer"].includes(outcome)) throw new Error("Invalid close outcome");
  const conversation = await repo.getConversationById(businessId, conversationId);
  if (!conversation || !conversation.leadId) throw new Error("Conversation has no lead");
  await setStatusAction(businessId, conversation.leadId, outcome);
  await repo.updateConversation(businessId, conversationId, { status: "closed" });
  if (outcome === "customer") {
    // Stop rule: a customer no longer receives follow-up sequences.
    await repo.cancelFollowUpsForLead(businessId, conversation.leadId);
  }
  const bundle = await getBundle(businessId, conversationId);
  if (!bundle) throw new Error("Conversation could not be loaded");
  return bundle;
}
