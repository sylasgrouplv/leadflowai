/**
 * Conversation memory (spec §27) — per-conversation short-term memory.
 *
 * Shape: customer_name, service, location, problem, urgency, appointment_intent,
 * preferences, previous_answers. Persisted as JSON on the conversation row
 * (memory_json), scoped to business + conversation only (spec §33: never cross
 * business, never cross customer).
 *
 * The orchestrator loads memory before each turn and injects it into the
 * provider context, so the AI never re-asks what it already collected and can
 * reference earlier facts ("Thanks, Dana — I've got you down for AC repair").
 *
 * No sensitive data is stored here: phone/email live on the lead row, not in
 * memory (spec §27: "no unnecessary sensitive data").
 */
import * as repo from "../db/repo";
import { extractInfo, PLACEHOLDER_NAME_RE, type LeadRow } from "./qualify";

export type MemoryUrgency = "emergency" | "urgent" | "soon" | "none";
export type MemoryAppointmentIntent = "ready" | "considering" | "none";

export interface ConversationMemory {
  /** Full customer name ("Dana Ortiz") once learned. */
  customerName?: string;
  /** Requested service as it appears in the business's service list. */
  service?: string;
  /** Customer location (zip or city) once learned. */
  location?: string;
  /** Short description of the customer's problem (first substantive message). */
  problem?: string;
  urgency?: MemoryUrgency;
  appointmentIntent?: MemoryAppointmentIntent;
  /** Reserved for later tasks (e.g. "contact by email"). */
  preferences?: Record<string, string>;
  /** The last few customer messages (≤3), so the generator can anchor on them. */
  previousAnswers?: string[];
  updatedAt?: number;
}

export const EMPTY_MEMORY: ConversationMemory = {};

const EMERGENCY_WORDS = ["emergency", "gas leak", "carbon monoxide", "fire", "smoke", "flood", "flooded", "burst pipe", "water everywhere"];
const URGENT_WORDS = ["urgent", "asap", "leaking", "broken", "no heat", "no ac", "not cooling", "not heating", "right away", "tonight", "today", "immediate"];
const BOOKING_WORDS = ["book", "booking", "schedule", "appointment", "come out", "come by", "when can", "what time", "visit", "set up a time", "availability", "available", "reserve", "slot"];

const GREETING_RE = /^(hi|hello|hey|good (morning|afternoon|evening)|thanks|thank you)[!. ]*$/i;

/** Load the conversation's memory (tenant-scoped via repo). */
export async function loadMemory(businessId: string, conversationId: string): Promise<ConversationMemory> {
  const conversation = await repo.getConversationById(businessId, conversationId);
  if (!conversation?.memoryJson) return { ...EMPTY_MEMORY };
  try {
    const parsed = JSON.parse(conversation.memoryJson);
    return parsed && typeof parsed === "object" ? (parsed as ConversationMemory) : { ...EMPTY_MEMORY };
  } catch {
    return { ...EMPTY_MEMORY };
  }
}

/** Persist the conversation's memory (tenant-scoped via repo). */
export async function saveMemory(businessId: string, conversationId: string, memory: ConversationMemory): Promise<void> {
  await repo.updateConversation(businessId, conversationId, {
    memoryJson: JSON.stringify({ ...memory, updatedAt: Date.now() }),
  });
}

/** True when memory carries no collected facts yet. */
export function memoryEmpty(memory: ConversationMemory): boolean {
  return !memory.customerName && !memory.service && !memory.location && !memory.problem;
}

/**
 * Extract memory-worthy facts from a single customer message, reusing the
 * deterministic extraction from the qualification engine (single source of
 * truth for name/service/location/urgency/booking intent).
 *
 * NOTE: extraction runs against the message alone (lead = null) even though
 * the lead row may already carry a real name — the engine qualifies the lead
 * BEFORE the orchestrator, so a lead-guarded extraction would never see the
 * in-chat name and memory would fail to learn it (spec §27: the AI must
 * remember what it collected across turns).
 */
export function extractMemoryFacts(
  message: string,
  lead: LeadRow | null,
  services: { name: string }[]
): Partial<ConversationMemory> {
  void lead; // extraction is intentionally message-only (see docstring)
  const info = extractInfo(null, message, services);
  const lower = message.toLowerCase();
  const out: Partial<ConversationMemory> = {};

  // Name — reject location/connective false starts ("I'm in Springfield" must
  // not produce a first name of "in").
  if (info.firstName && !BAD_NAME_START_RE.test(info.firstName)) {
    out.customerName = [info.firstName, info.lastName ?? ""].filter(Boolean).join(" ").trim();
  }
  if (info.serviceRequested) out.service = info.serviceRequested;
  if (info.location) out.location = info.location;

  if (EMERGENCY_WORDS.some((w) => lower.includes(w))) out.urgency = "emergency";
  else if (info.urgent || URGENT_WORDS.some((w) => lower.includes(w))) out.urgency = "urgent";

  if (info.bookingIntent || BOOKING_WORDS.some((w) => lower.includes(w))) out.appointmentIntent = "ready";
  else if (out.service) out.appointmentIntent = "considering";

  return out;
}

const BAD_NAME_START_RE = /^(in|at|near|from|the|a|my|our|i|im|located|around|on|for|please|can|could|need|have|is|am)$/i;

/**
 * Merge newly extracted facts into the existing memory. Existing values win
 * unless the message provides a stronger/earlier fact (urgency and appointment
 * intent only move forward, never back to weaker values).
 */
export function mergeMemory(
  memory: ConversationMemory,
  facts: Partial<ConversationMemory>,
  message: string
): ConversationMemory {
  const next: ConversationMemory = { ...memory };
  if (facts.customerName) next.customerName = facts.customerName;
  if (facts.service) next.service = facts.service;
  if (facts.location) next.location = facts.location;
  if (facts.urgency) {
    const rank: Record<string, number> = { none: 0, soon: 1, urgent: 2, emergency: 3 };
    if ((rank[facts.urgency] ?? 0) > (rank[next.urgency ?? "none"] ?? 0)) next.urgency = facts.urgency;
  }
  if (facts.appointmentIntent) {
    const rank: Record<string, number> = { none: 0, considering: 1, ready: 2 };
    if ((rank[facts.appointmentIntent] ?? 0) > (rank[next.appointmentIntent ?? "none"] ?? 0)) {
      next.appointmentIntent = facts.appointmentIntent;
    }
  }
  // Problem: the first substantive (non-greeting) message becomes the problem
  // description; later messages don't overwrite it.
  if (!next.problem && !GREETING_RE.test(message.trim()) && message.trim().length > 3) {
    next.problem = message.trim().slice(0, 240);
  }
  // Previous answers: keep the last 3 customer messages as lightweight context.
  const answers = [...(next.previousAnswers ?? [])];
  answers.push(message.trim().slice(0, 200));
  next.previousAnswers = answers.slice(-3);
  return next;
}

/** True when two memories hold the same facts (updatedAt ignored). */
export function memoryEqual(a: ConversationMemory, b: ConversationMemory): boolean {
  return (
    a.customerName === b.customerName &&
    a.service === b.service &&
    a.location === b.location &&
    a.problem === b.problem &&
    a.urgency === b.urgency &&
    a.appointmentIntent === b.appointmentIntent
  );
}

/** The lead's real first name, or null when it's a channel placeholder/unknown. */
export function realFirstName(lead: LeadRow | null, memory?: ConversationMemory): string | null {
  const mem = memory?.customerName?.split(/\s+/)[0];
  if (mem && mem.length > 1 && !PLACEHOLDER_NAME_RE.test(mem)) return mem;
  if (!lead) return null;
  const first = (lead.firstName ?? "").trim();
  if (!first || PLACEHOLDER_NAME_RE.test(first)) return null;
  return first;
}

export { PLACEHOLDER_NAME_RE };
