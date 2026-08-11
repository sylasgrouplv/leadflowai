/**
 * Integration provider contracts.
 *
 * Every external system LeadFlow touches (AI, SMS, email, calendar, CRM,
 * Stripe) is behind a small interface with a Mock implementation. Factories in
 * ./index.ts select an implementation from an env var, so swapping in a real
 * provider (OpenAI, Twilio, SendGrid, Google Calendar, HubSpot, Stripe) is a
 * new class + an env change — no app code touched.
 */

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// AI Agent Brain — orchestrator provider contract (spec §2, §42)
//
// The provider has two jobs and nothing else:
//   1. classifyIntent  — detect the intent (one of the 13) + confidence level.
//   2. generateReply   — produce the KB-grounded customer-facing reply for the
//                        routed intent, given business context + conversation
//                        memory. Must NEVER fabricate: it answers only from the
//                        provided context, and returns answerConfidence LOW
//                        when it lacks sufficient knowledge (the orchestrator
//                        then clarifies or escalates — never guesses).
// The mock is rule-based; a real LLM provider (openai/anthropic stubs) swaps
// in via AI_PROVIDER env — config-only, same interface.
// ---------------------------------------------------------------------------
import type { Intent, ConfidenceLevel } from "../ai/intents";
import type { ConversationMemory } from "../ai/memory";

export interface AiIntentInput {
  message: string;
  businessName: string;
  services: { name: string }[];
  memory: ConversationMemory;
}

export interface AiIntentResult {
  intent: Intent;
  confidence: ConfidenceLevel;
}

export interface AiGenerateInput {
  businessId: string;
  businessName: string;
  message: string;
  intent: Intent;
  intentConfidence: ConfidenceLevel;
  services: { name: string; description: string; priceCents: number }[];
  knowledge: { kind: string; question: string; answer: string }[];
  policies: { cancellationPolicy: string; financing: string; promotions: string; welcomeMessage: string };
  hours: Record<string, { open: string; close: string; closed: boolean }>;
  serviceArea: { zipCodes: string[]; cities: string[] };
  escalation: { sensitivity: "Conservative" | "Balanced" | "Aggressive" | "low" | "medium" | "high"; keywords: string[] };
  /** Conversation short-term memory (spec §27) — never re-ask what's here. */
  memory: ConversationMemory;
  /** Lead row facts available to the AI (no internal notes, no other customers). */
  lead: {
    firstName: string;
    lastName: string;
    phone: string;
    email: string;
    serviceRequested: string;
    location: string;
    status: string;
    score: string;
  } | null;
  /** Whether the lead already holds a booked/confirmed appointment. */
  hasAppointment: boolean;
  conversation: { channel: string; status: string };
  history: AiMessage[];
  /** Spec §38 — agent name, tone, response length (shape the reply). */
  agentName?: string;
  tone?: "Professional" | "Friendly" | "Casual" | "Concise";
  responseLength?: "Short" | "Medium" | "Detailed";
}

export interface AiUsageEstimate {
  inputTokens: number;
  outputTokens: number;
  /** Deterministic estimated cost in cents — always an estimate (spec §32). */
  estimatedCostCents: number;
}

export interface AiGeneratedReply {
  reply: string;
  /** How ready the AI is to answer from provided context (spec §26). */
  answerConfidence: ConfidenceLevel;
  /** True when the reply is the standardized "no grounded answer" phrasing —
   *  the orchestrator uses this flag (not string equality) to decide
   *  clarify vs escalate. */
  noAnswer?: boolean;
  /** Deterministic token/cost estimate reported by the provider (spec §32). */
  usage?: AiUsageEstimate;
}

export interface AiRequest {
  businessId: string;
  businessName: string;
  message: string;
  history: AiMessage[];
  services: { name: string; description: string; priceCents: number }[];
  knowledge: { kind: string; question: string; answer: string }[];
  policies: { cancellationPolicy: string; financing: string; promotions: string; welcomeMessage: string };
  hours: Record<string, { open: string; close: string; closed: boolean }>;
  serviceArea: { zipCodes: string[]; cities: string[] };
  /**
   * Owner-configured escalation behavior (spec §13 + §32 criterion 5).
   * sensitivity: low = only severe triggers, medium = standard triggers,
   * high = standard triggers + uncertainty. keywords: owner phrases that
   * always escalate regardless of sensitivity.
   */
  escalation?: {
    sensitivity: "Conservative" | "Balanced" | "Aggressive" | "low" | "medium" | "high";
    keywords: string[];
  };
}

export interface AiResponse {
  reply: string;
  intent: "answer" | "qualify" | "book" | "escalate" | "unknown";
  confidence: number;
}

export interface AiProvider {
  readonly name: string;
  /** Spec §2 — detect intent + confidence for a customer message. */
  classifyIntent(input: AiIntentInput): Promise<AiIntentResult>;
  /** Spec §5 — KB-grounded reply generation for the routed intent. */
  generateReply(input: AiGenerateInput): Promise<AiGeneratedReply>;
  /** Legacy single-shot respond (kept for compatibility). */
  respond(req: AiRequest): Promise<AiResponse>;
}

// ---------------------------------------------------------------------------

export interface SmsMessage {
  to: string;
  body: string;
}

export interface SmsProvider {
  readonly name: string;
  send(msg: SmsMessage): Promise<{ id: string; status: "delivered" }>;
}

// ---------------------------------------------------------------------------

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ id: string; status: "delivered" }>;
}

// ---------------------------------------------------------------------------

export interface AvailabilitySlot {
  startAt: number;
  endAt: number;
}

export interface CalendarBookInput {
  businessId: string;
  leadId: string;
  serviceId: string | null;
  startAt: number;
  endAt: number;
}

export interface CalendarProvider {
  readonly name: string;
  /**
   * Returns open slots for a day. `hours` is the business's weekly schedule,
   * `booked` the already-taken intervals. Providers MUST NOT invent
   * availability: slots are always within open hours and never overlap booked.
   */
  getAvailability(input: {
    businessId: string;
    date: string; // YYYY-MM-DD
    durationMin: number;
    hours: Record<string, { open: string; close: string; closed: boolean }>;
    booked: AvailabilitySlot[];
  }): Promise<AvailabilitySlot[]>;
  book(input: CalendarBookInput): Promise<{ id: string }>;
  cancel(businessId: string, providerEventId: string): Promise<void>;
}

// ---------------------------------------------------------------------------

export interface CrmLead {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  serviceRequested: string;
  status: string;
  score: string;
}

export interface CrmProvider {
  readonly name: string;
  syncLead(lead: CrmLead): Promise<{ ok: true; externalId: string }>;
  updateLeadStatus(leadId: string, status: string): Promise<{ ok: true }>;
}

// ---------------------------------------------------------------------------

export interface StripeProvider {
  readonly name: string;
  createCustomer(opts: { email: string; name: string; businessId: string }): Promise<{ customerId: string }>;
  createSubscription(opts: { customerId: string; plan: string; businessId: string }): Promise<{ subscriptionId: string; status: string }>;
  cancelSubscription(subscriptionId: string): Promise<{ ok: true }>;
  /** Returns a hosted checkout URL. */
  createCheckoutSession(opts: { businessId: string; plan: string; successUrl: string }): Promise<{ url: string }>;
}
