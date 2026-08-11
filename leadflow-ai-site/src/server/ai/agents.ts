/**
 * Agent registry (spec §1) — the seven specialized agents and the intent →
 * agent routing table.
 *
 * Dispatch policy:
 *   - Receptionist / Qualification / Appointment / Escalation route to the
 *     existing implementations (engine reply path, qualify.ts, appointments
 *     agent, engine escalation flow).
 *   - Follow-Up / Review / Business Intelligence are routing skeletons only —
 *     their logic arrives in later tasks. The registry carries their intent
 *     mapping now so the orchestrator's route log is complete and the slots
 *     are ready to fill.
 *
 * Escalation overrides routing: when the orchestrator decides to escalate,
 * the Human Escalation Manager handles the turn regardless of intent.
 */
import type { Intent } from "./intents";

export const AGENT_IDS = [
  "receptionist",
  "qualification",
  "appointment",
  "followup",
  "review",
  "bi",
  "escalation",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentDef {
  id: AgentId;
  name: string;
  /** Spec §1 role description. */
  description: string;
  /** Intents this agent owns once routed. */
  intents: Intent[];
  /** "implemented" routes to working code today; "skeleton" is a stub for a later task. */
  status: "implemented" | "skeleton";
  /** Where the logic lives today (for handoff). */
  implementation: string;
}

export const AGENT_REGISTRY: AgentDef[] = [
  {
    id: "receptionist",
    name: "AI Receptionist",
    description: "Primary customer-facing agent: greet, identify intent, collect lead info, answer basic questions, qualify, start booking, escalate.",
    intents: ["GENERAL_QUESTION", "NEW_LEAD", "SERVICE_INQUIRY", "PRICE_INQUIRY", "FOLLOW_UP", "UNKNOWN"],
    status: "implemented",
    implementation: "src/server/ai/engine.ts (reply path) + src/server/integrations/ai.ts (KB-grounded generator)",
  },
  {
    id: "qualification",
    name: "Lead Qualification Agent",
    description: "Collects structured lead data, generates score + classification.",
    intents: ["NEW_LEAD", "SERVICE_INQUIRY"],
    status: "implemented",
    implementation: "src/server/ai/qualify.ts (qualifyLead/extractInfo/score actions)",
  },
  {
    id: "appointment",
    name: "Appointment Agent",
    description: "Availability, booking, rescheduling, cancellation, confirmation.",
    intents: ["APPOINTMENT_REQUEST", "APPOINTMENT_CHANGE", "APPOINTMENT_CANCEL"],
    status: "implemented",
    implementation: "src/server/appointments/agent.ts (checkCalendarAction/bookAppointmentAction); cancel routes to Human Escalation Manager (HIGH-RISK tool, spec §24)",
  },
  {
    id: "followup",
    name: "Follow-Up Agent",
    description: "Unconverted leads: sequence 24h → 48h → 4d → 7d; stop on booked/opt-out/customer/manual/lost.",
    intents: ["FOLLOW_UP"],
    status: "skeleton",
    implementation: "Routing only — engine exists at src/server/followups/engine.ts; conversation-routed follow-up logic is a later task.",
  },
  {
    id: "review",
    name: "Customer Review Agent",
    description: "Post-completed-job feedback; positive → review link; negative → internal task.",
    intents: [],
    status: "implemented",
    implementation: "src/server/reviews/agent.ts — event JOB_COMPLETED → send_review_request (delayed) → record_feedback (sentiment → review link or human task)",
  },
  {
    id: "bi",
    name: "Business Intelligence Agent",
    description: "Weekly report: lead volume/sources/quality, rates, revenue attribution.",
    intents: [],
    status: "implemented",
    implementation: "src/server/bi/report.ts — deterministic weekly aggregation + mock-LLM narrative (weekly worker timer + manual trigger)",
  },
  {
    id: "escalation",
    name: "Human Escalation Manager",
    description: "Creates escalation tasks (priority, lead_id, reason, conversation_summary, recommended_action).",
    intents: ["COMPLAINT", "REFUND_REQUEST", "HUMAN_REQUEST", "EMERGENCY", "APPOINTMENT_CANCEL"],
    status: "implemented",
    implementation: "src/server/ai/engine.ts escalation branch (needs_human status + notification + AI quiet)",
  },
];

export function getAgent(id: AgentId): AgentDef {
  const agent = AGENT_REGISTRY.find((a) => a.id === id);
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  return agent;
}

/** Route an intent to its owning agent (escalation handled separately by the orchestrator). */
export function routeIntent(intent: Intent): AgentDef {
  const match = AGENT_REGISTRY.find((a) => a.intents.includes(intent));
  return match ?? getAgent("receptionist");
}
