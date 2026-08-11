/**
 * AI Orchestrator (spec §2) — the central decision layer of the AI Agent Brain.
 *
 * Per customer message:
 *   (a) detect intent + confidence        (provider.classifyIntent)
 *   (b) load business context (spec §4)   (this business ONLY — spec §33)
 *   (c) knowledge retrieval (spec §5)     (provider generates from context)
 *   (d) route to the specialized agent    (agent registry)
 *   (e) decide if a tool/action is needed (availability for appointment intent,
 *       qualification/status actions, service-area check)
 *   (f) decide if human escalation is needed (spec §18 triggers, §26 LOW
 *       confidence, safety rule 7)
 *   (g) maintain conversation state       (short-term memory, spec §27)
 *   (h) record agent actions              (agent_actions rows)
 *   (i) return the reply + routing metadata for the engine to apply
 *
 * Global safety rules (spec §3) are enforced HERE, centrally, for every agent:
 *   - never fabricate (UNKNOWN/LOW → clarify or escalate, never guess),
 *   - never invent availability (the engine only ever appends REAL slots from
 *     checkCalendarAction — the orchestrator only sets the needsAvailability
 *     flag),
 *   - never invent pricing (the provider answers only from configured pricing,
 *     else the estimate phrase),
 *   - respect opt-outs (the engine intercepts "stop"/"unsubscribe" before any
 *     AI work; see engine.handleLeadMessage),
 *   - escalate uncertainty / protect private info (the provider context never
 *     includes internal notes, other customers, employees, keys, or prompts).
 *
 * The AI never touches the database directly: every mutation below goes
 * through the validated action functions (qualify.ts / appointments agent) or
 * repo helpers, each tenant-scoped by businessId.
 */
import * as repo from "../db/repo";
import { getAiProvider } from "../integrations";
import type { AiRequest, AiGeneratedReply } from "../integrations/types";
import { buildHistory } from "./context";
import type { LeadRow } from "./qualify";
import { AGENT_REGISTRY, routeIntent, getAgent, type AgentId, type AgentDef } from "./agents";
import { loadMemory, saveMemory, extractMemoryFacts, mergeMemory, memoryEqual, memoryEmpty } from "./memory";
import type { ConversationMemory } from "./memory";
import { isIntent, type Intent, type ConfidenceLevel } from "./intents";
import { serviceAreaVerdict, type AreaVerdict } from "./tools/area";
import { callAiTool } from "./tools/registry";
import {
  UNKNOWN_CLARIFY_REPLY,
  UNKNOWN_ESCALATION_REPLY,
  ESCALATION_REPLY,
  CANCEL_ESCALATION_REPLY,
} from "../integrations/ai";

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export type HoursMap = AiRequest["hours"];

// ---------------------------------------------------------------------------
// Escalation (spec §18 triggers + safety rule 7)
// ---------------------------------------------------------------------------

export interface EscalationDecision {
  triggered: boolean;
  reason: string | null;
}

const ANGRY_KEYWORDS = [
  "angry", "furious", "terrible", "horrible", "unacceptable", "complain", "complaint",
  "rude", "damaged my", "damaged our", "broke my", "ruined", "lawyer", "lawsuit", "sue",
  "legal", "attorney", "refund",
];

/** Spec §18 triggers — checked centrally, before any agent runs. */
function evaluateEscalation(opts: {
  businessName: string;
  message: string;
  intent: Intent;
  intentConfidence: ConfidenceLevel;
  aiConfig: repo.AiConfig;
  hasLead: boolean;
}): EscalationDecision {
  const { message, intent, intentConfidence, aiConfig } = opts;
  const lower = message.toLowerCase();

  if (intent === "EMERGENCY") return { triggered: true, reason: "emergency" };
  if (intent === "COMPLAINT") return { triggered: true, reason: "complaint" };
  if (intent === "REFUND_REQUEST") return { triggered: true, reason: "refund-request" };
  if (intent === "HUMAN_REQUEST") return { triggered: true, reason: "human-request" };
  if (intent === "APPOINTMENT_CANCEL") return { triggered: true, reason: "high-risk-action-cancel" };

  // Owner-configured keywords always escalate (spec §13).
  if (aiConfig.escalationKeywords.some((k) => k && lower.includes(k.toLowerCase()))) {
    return { triggered: true, reason: "owner-keyword" };
  }
  // Standard angry/legal/damage phrases (independent of the classifier, so the
  // safety net works even if intent detection is ambiguous).
  if (ANGRY_KEYWORDS.some((k) => lower.includes(k))) return { triggered: true, reason: "angry-or-legal" };

  // Uncertainty escalates on high sensitivity (spec §18 "AI lacks info").
  if (intent === "UNKNOWN" && intentConfidence === "LOW" && aiConfig.escalationSensitivity === "high") {
    return { triggered: true, reason: "low-confidence-unknown" };
  }
  return { triggered: false, reason: null };
}

// ---------------------------------------------------------------------------
// Service-area enforcement (spec §9: outside area → UNQUALIFIED)
// ---------------------------------------------------------------------------

export type { AreaVerdict };
export { serviceAreaVerdict };

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface OrchestrateInput {
  businessId: string;
  conversationId: string;
  /** The customer's message (already trimmed). */
  message: string;
  /** The conversation's lead (may be null before a lead is linked). */
  lead: LeadRow | null;
}

export interface OrchestrationResult {
  reply: string;
  intent: Intent;
  intentConfidence: ConfidenceLevel;
  answerConfidence: ConfidenceLevel;
  agent: AgentDef;
  escalate: boolean;
  escalationReason: string | null;
  /** True when the engine must append REAL calendar availability (spec rule 2). */
  needsAvailability: boolean;
  /** The (possibly updated) conversation memory for the caller. */
  memory: ConversationMemory;
  outsideArea: boolean;
}

export async function orchestrate(input: OrchestrateInput): Promise<OrchestrationResult> {
  const { businessId, conversationId, message, lead } = input;

  // (b) Business context — tenant-scoped by construction (spec §33: every AI
  // request carries business_id; retrieval only ever reads THIS business).
  const [business, conversation, services, knowledge, aiConfig] = await Promise.all([
    repo.getBusinessById(businessId),
    repo.getConversationById(businessId, conversationId),
    repo.listServices(businessId),
    repo.listKnowledge(businessId),
    repo.getAiConfig(businessId),
  ]);
  if (!business) throw new Error("Business not found");
  if (!conversation) throw new Error("Conversation not found");

  const hours = safeJson<HoursMap>(business.hoursJson, {});
  const serviceArea = safeJson<{ zipCodes: string[]; cities: string[] }>(business.serviceAreaJson, { zipCodes: [], cities: [] });
  const policies = safeJson<AiRequest["policies"]>(business.policiesJson, {
    cancellationPolicy: "",
    financing: "",
    promotions: "",
    welcomeMessage: "",
  });
  const serviceNames = services.map((s) => ({ name: s.name }));

  // (g) Conversation memory (spec §27) — scoped to business + conversation.
  let memory: ConversationMemory = await loadMemory(businessId, conversationId);

  // (a) Intent detection via the provider interface (spec §2).
  const provider = getAiProvider();
  const cls = await provider.classifyIntent({ message, businessName: business.name, services: serviceNames, memory });
  const intent: Intent = isIntent(cls.intent) ? cls.intent : "UNKNOWN";
  const intentConfidence: ConfidenceLevel = cls.confidence;

  // (f) Escalation decision — central safety net (spec §18, §3 rule 7).
  const escalation = evaluateEscalation({
    businessName: business.name,
    message,
    intent,
    intentConfidence,
    aiConfig,
    hasLead: !!lead,
  });

  // (h) Record intent detection + confidence (spec §2/§26 audit trail).
  await repo.logAgentAction(businessId, {
    agent: "orchestrator",
    action: "detect_intent",
    leadId: lead?.id,
    input: { message, conversationId },
    result: { intent, confidence: intentConfidence, escalate: escalation.reason ?? null },
    success: true,
  });

  // (g) Merge this turn's facts into memory and persist when changed.
  const facts = extractMemoryFacts(message, lead, services);
  const nextMemory = mergeMemory(memory, facts, message);
  if (!memoryEqual(memory, nextMemory)) {
    memory = nextMemory;
    await saveMemory(businessId, conversationId, memory);
  }

  // (e) Service-area action: outside area → UNQUALIFIED (spec §9) — logged.
  let outsideArea = false;
  const leadLocation = lead?.location || memory.location || "";
  if (lead && leadLocation) {
    const verdict = serviceAreaVerdict(leadLocation, serviceArea);
    if (verdict === "outside") {
      outsideArea = true;
      // Mutation path — through the tool registry (spec §24): validated + audited.
      try {
        await callAiTool("set_lead_status", { businessId, agent: "qualification", conversationId }, { lead_id: lead.id, status: "unqualified" });
      } catch (e) {
        console.error("[orchestrator] set_lead_status(unqualified) failed:", e);
      }
    }
    await repo.logAgentAction(businessId, {
      agent: "qualification",
      action: "service_area_check",
      leadId: lead.id,
      input: { location: leadLocation },
      result: { verdict, serviceArea },
      success: true,
    });
  }

  // (d) Route to the specialized agent (spec §1/§2) + record the route.
  const agent: AgentDef = escalation.triggered ? getAgent("escalation") : routeIntent(intent);
  await repo.logAgentAction(businessId, {
    agent: "orchestrator",
    action: "route",
    leadId: lead?.id,
    input: { intent },
    result: { agent: agent.id, agentStatus: agent.status },
    success: true,
  });

  // (e) Tool need: appointment requests need REAL calendar availability.
  const needsAvailability = intent === "APPOINTMENT_REQUEST" && !outsideArea && !escalation.triggered;

  const history = await buildHistory(businessId, conversationId);
  const hasAppointment = !!lead && (await repo.listAppointmentsForLead(businessId, lead.id)).some((r) =>
    ["booked", "confirmed"].includes(r.appointment.status)
  );
  const generateInput = {
    businessId,
    businessName: business.name,
    message,
    intent,
    intentConfidence,
    services: services.map((s) => ({ name: s.name, description: s.description ?? "", priceCents: s.priceCents })),
    knowledge: knowledge.map((k) => ({ kind: k.kind, question: k.question ?? "", answer: k.answer })),
    policies,
    hours,
    serviceArea,
    escalation: { sensitivity: aiConfig.escalationSensitivity, keywords: aiConfig.escalationKeywords },
    memory,
    lead: lead
      ? {
          firstName: lead.firstName,
          lastName: lead.lastName ?? "",
          phone: lead.phone ?? "",
          email: lead.email ?? "",
          serviceRequested: lead.serviceRequested ?? "",
          location: lead.location ?? "",
          status: lead.status,
          score: lead.score,
        }
      : null,
    hasAppointment,
    conversation: { channel: conversation.channel, status: conversation.status },
    history,
  };

  // (i) Generate the reply — grounded ONLY in this business's context + memory.
  let gen: AiGeneratedReply;
  let escalate = escalation.triggered;
  let escalationReason = escalation.reason;

  if (outsideArea) {
    gen = { reply: outsideAreaReply(business.name, serviceArea), answerConfidence: "HIGH" };
  } else if (escalation.triggered) {
    if (intent === "EMERGENCY") {
      gen = await provider.generateReply(generateInput); // KB emergency info, if configured
    } else if (intent === "APPOINTMENT_CANCEL") {
      gen = { reply: CANCEL_ESCALATION_REPLY, answerConfidence: "HIGH" };
    } else {
      gen = { reply: ESCALATION_REPLY, answerConfidence: "HIGH" };
    }
  } else {
    gen = await provider.generateReply(generateInput);
  }

  // Spec §26: LOW answer readiness → clarify or escalate — never fabricate.
  // A LOW answer that is already a safe grounded reply (e.g. the pricing
  // estimate phrase) stays as-is; only a genuine "no answer" (the clarify
  // reply) triggers the clarify/escalate path.
  if (!escalate && gen.answerConfidence === "LOW") {
    const noAnswer = gen.reply === UNKNOWN_CLARIFY_REPLY;
    if (intent === "UNKNOWN" || (noAnswer && aiConfig.escalationSensitivity === "high")) {
      escalate = true;
      escalationReason = "low-confidence-unknown";
      gen = { reply: UNKNOWN_ESCALATION_REPLY, answerConfidence: "LOW" };
    }
  }

  // (h) Record the generated reply + answer confidence.
  await repo.logAgentAction(businessId, {
    agent: agent.status === "skeleton" ? agent.id : agent.id === "escalation" ? "escalation" : "receptionist",
    action: agent.id === "escalation" ? "escalate" : "generate_reply",
    leadId: lead?.id,
    input: { intent, message },
    result: { reply: gen.reply, answerConfidence: gen.answerConfidence, routedAgent: agent.id },
    success: true,
  });

  return {
    reply: gen.reply,
    intent,
    intentConfidence,
    answerConfidence: gen.answerConfidence,
    agent,
    escalate,
    escalationReason,
    needsAvailability,
    memory,
    outsideArea,
  };
}

function outsideAreaReply(businessName: string, area: { zipCodes: string[]; cities: string[] }): string {
  const places = [...area.cities, ...area.zipCodes];
  const where = places.length ? ` ${places.slice(0, 8).join(", ")}` : "";
  return (
    `Thanks — I checked our service area and we currently serve${where}. I'm not sure we can reach your location, ` +
    `so I've passed your details to the team to confirm. (I'm the AI receptionist for ${businessName}.)`
  );
}

/** Registry access for tests / future admin surfaces. */
export { AGENT_REGISTRY, memoryEmpty };
