/**
 * Real LLM provider prompt builders + result parsers (spec §42).
 *
 * The OpenAI and Anthropic providers share the exact orchestrator contract
 * (classifyIntent / generateReply) but call different HTTP APIs. To keep the
 * two implementations symmetric, this module owns:
 *
 *   - the system prompt rendered from the orchestrator context (intent
 *     taxonomy for classification; business KB/services/policies/hours/area
 *     for generation) plus the global AI safety rules (spec §3 — never
 *     fabricate, answer only from provided context; LOW confidence → clarify /
 *     escalate), and
 *   - defensive parsers that turn the model's JSON reply into the typed
 *     AiIntentResult / AiGeneratedReply shapes the orchestrator consumes.
 *
 * Every parser is defensive: a malformed / non-JSON model response never
 * crashes the call — it degrades to a safe default (classification → UNKNOWN /
 * LOW; generation → the never-fabricate clarify reply with noAnswer).
 */
import type {
  AiGenerateInput,
  AiGeneratedReply,
  AiIntentResult,
  AiMessage,
  AiUsageEstimate,
} from "./types";
import type { Intent, ConfidenceLevel } from "../ai/intents";
import { INTENTS, INTENT_LABELS, isIntent } from "../ai/intents";
import { estimateTokens } from "./ai";
import { UNKNOWN_CLARIFY_REPLY } from "./ai";

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

/** Human-readable, label-led description of the 13-intent taxonomy. */
export const INTENT_GUIDE = INTENTS.map(
  (k) => `- ${k} — ${INTENT_LABELS[k]}`
).join("\n");

export function buildClassifyPrompt(input: {
  message: string;
  businessName: string;
  services: { name: string }[];
}): { system: string; user: string } {
  const services =
    input.services && input.services.length
      ? input.services.map((s) => s.name).join(", ")
      : "(none configured)";
  const system = [
    `You are the intent classifier for ${input.businessName}'s AI receptionist.`,
    `Classify the CUSTOMER's message into exactly ONE of these intents:`,
    INTENT_GUIDE,
    ``,
    `Rules:`,
    `- A life-safety message (gas leak, fire, carbon monoxide, flood, etc.) is EMERGENCY.`,
    `- Asking for a person/manager or to "talk to a human" is HUMAN_REQUEST.`,
    `- Refunds/complaints/emotional frustration are REFUND_REQUEST / COMPLAINT.`,
    `- Requesting an appointment or asking when someone can come out is APPOINTMENT_REQUEST.`,
    `- Asking cost/price/quote/estimate is PRICE_INQUIRY.`,
    `- A first-contact "I need help" with a service is NEW_LEAD or SERVICE_INQUIRY.`,
    `- Anything you cannot confidently route is UNKNOWN.`,
    ``,
    `Business services offered: ${services}.`,
    ``,
    `Reply with ONLY a JSON object: {"intent":"<one of the 13 keys>","confidence":"HIGH|MEDIUM|LOW"}.`,
    `No explanation, no markdown.`,
  ].join("\n");
  return { system, user: input.message };
}

export function parseIntent(text: string): AiIntentResult {
  const clean = extractJson(text);
  let intent: Intent = "UNKNOWN";
  let confidence: ConfidenceLevel = "LOW";
  if (clean) {
    const rawIntent = String(clean.intent ?? "").trim().toUpperCase();
    if (isIntent(rawIntent)) intent = rawIntent;
    const rawConf = String(clean.confidence ?? "").trim().toUpperCase();
    if (rawConf === "HIGH" || rawConf === "MEDIUM" || rawConf === "LOW") confidence = rawConf;
  }
  return { intent, confidence };
}

// ---------------------------------------------------------------------------
// Reply generation
// ---------------------------------------------------------------------------

/** Render the business grounding context + safety rules as the system prompt. */
export function buildGenerateSystemPrompt(input: AiGenerateInput): string {
  const p = input.policies ?? ({} as AiGenerateInput["policies"]);
  const hours =
    input.hours && Object.keys(input.hours).length
      ? Object.entries(input.hours)
          .filter(([, h]) => h && !h.closed)
          .map(([d, h]) => `${d[0].toUpperCase()}${d.slice(1)}: ${h.open}–${h.close}`)
          .join("; ")
      : "(none configured)";
  const area = input.serviceArea
    ? [...(input.serviceArea.cities ?? []), ...(input.serviceArea.zipCodes ?? [])].join(", ")
    : "";
  const knowledge = (input.knowledge ?? [])
    .map((k) => `Q: ${k.question || "(general)"}\nA: ${k.answer}`)
    .join("\n\n");
  const services = (input.services ?? [])
    .map((s) => {
      const price = s && typeof s.priceCents === "number" && s.priceCents > 0 ? ` ($${(s.priceCents / 100).toFixed(2)})` : "";
      return `- ${s.name}${price}${s.description ? ` — ${s.description}` : ""}`;
    })
    .join("\n");
  const memory = input.memory ?? {};
  const memoryFacts = [
    memory.customerName ? `customer name: ${memory.customerName}` : "",
    memory.service ? `requested service: ${memory.service}` : "",
    memory.location ? `location: ${memory.location}` : "",
    memory.problem ? `problem: ${memory.problem}` : "",
    memory.urgency ? `urgency: ${memory.urgency}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  const lead = input.lead;
  const leadFacts = lead
    ? `first: ${lead.firstName}${lead.lastName ? " " + lead.lastName : ""}${lead.location ? `, ${lead.location}` : ""}${lead.serviceRequested ? `, service: ${lead.serviceRequested}` : ""}`
    : "(no lead row yet)";

  const tone = (input.tone ?? "Professional").toLowerCase();
  const length = (input.responseLength ?? "Medium").toLowerCase();
  const agentName = input.agentName?.trim() || "AI receptionist";
  const sensitivity = (input.escalation?.sensitivity ?? "medium").toLowerCase();

  return [
    `You are ${agentName}, the AI receptionist for ${input.businessName}.`,
    `Answer the CUSTOMER's latest message using ONLY the business context below.`,
    ``,
    `BUSINESS CONTEXT (ground truth — never invent anything beyond it):`,
    `Hours: ${hours}`,
    `Service area: ${area || "(not configured)"}`,
    `Services offered:${services || "\n(none configured)"}`,
    ``,
    `Knowledge base FAQ:`,
    knowledge || "(none configured)",
    ``,
    `Policies:`,
    `- Cancellation: ${p.cancellationPolicy || "(none)"}`,
    `- Financing: ${p.financing || "(none)"}`,
    `- Promotions: ${p.promotions || "(none)"}`,
    `- Welcome message: ${p.welcomeMessage || "(none)"}`,
    ``,
    `This conversation's memory: ${memoryFacts || "(none yet)"}`,
    `Lead facts: ${leadFacts}`,
    ``,
    `SAFETY RULES (spec §3 — absolutely binding):`,
    `1. NEVER fabricate prices, availability, hours, or any fact not present above.`,
    `2. Answer ONLY from the provided context.`,
    `3. If the customer asks something the context cannot answer with certainty, respond with EXACTLY this phrase (verbatim): "${UNKNOWN_CLARIFY_REPLY}" and set noAnswer to true.`,
    `4. TONE: ${tone}. RESPONSE LENGTH: ${length} (keep it brisk: Short ~2 sentences, Medium ~3, Detailed up to ~6).`,
    `5. The lead's name is ${leadFacts}; use it naturally once known, never invent one.`,
    `6. Escalation sensitivity for this business: ${sensitivity}.`,
    ``,
    `Reply with ONLY a JSON object: {"reply":"<the customer-facing reply>","confidence":"HIGH|MEDIUM|LOW","noAnswer":true|false}.`,
    `No explanation, no markdown, no signature line.`,
  ].join("\n");
}

/** Conversation history as chat messages (kept inside the provider boundary). */
export function buildHistoryMessages(history: AiMessage[]): AiMessage[] {
  return (history ?? []).filter((m) => m && typeof m.content === "string");
}

export interface ParsedGenerate {
  reply: string;
  answerConfidence: ConfidenceLevel;
  noAnswer: boolean;
}

export function parseGenerate(text: string): ParsedGenerate {
  const clean = extractJson(text);
  let reply = "";
  let answerConfidence: ConfidenceLevel = "LOW";
  let noAnswer = false;
  if (clean) {
    reply = typeof clean.reply === "string" ? clean.reply.trim() : "";
    const rawConf = String(clean.confidence ?? "").trim().toUpperCase();
    if (rawConf === "HIGH" || rawConf === "MEDIUM" || rawConf === "LOW") answerConfidence = rawConf;
    if (clean.noAnswer === true) noAnswer = true;
  }
  // Never-fabricate guarantee: if we didn't get a usable reply, fall back to the
  // standardized clarify phrasing with noAnswer so the orchestrator never sees
  // an empty string.
  if (!reply) {
    reply = UNKNOWN_CLARIFY_REPLY;
    noAnswer = true;
    answerConfidence = "LOW";
  }
  return { reply, answerConfidence, noAnswer };
}

// ---------------------------------------------------------------------------
// Usage accounting (spec §32) — maps real model token counts to the estimate.
// ---------------------------------------------------------------------------

/**
 * Build the deterministic usage estimate a provider reports. Real token counts
 * come from the API response when present; otherwise estimate locally. Rate
 * card (documented, gpt-4o-mini-class): $0.15 / 1M input + $0.60 / 1M output,
 * floored at 1 cent — same contract as the mock so cost control is identical
 * across providers.
 */
export function estimateUsageFromTokens(
  input: AiGenerateInput,
  reply: string,
  tokens?: { inputTokens: number; outputTokens: number }
): AiUsageEstimate {
  let inputTokens: number;
  let outputTokens: number;
  if (tokens && tokens.inputTokens > 0 && tokens.outputTokens >= 0) {
    inputTokens = tokens.inputTokens;
    outputTokens = tokens.outputTokens;
  } else {
    const historyText = (input.history ?? []).map((m) => m.content).join(" ");
    const serviceNames = (input.services ?? []).map((s) => s.name).join(" ");
    inputTokens = estimateTokens(`${input.message} ${historyText} ${input.businessName} ${serviceNames}`);
    outputTokens = estimateTokens(reply);
  }
  const rawCents = ((inputTokens * 0.15 + outputTokens * 0.6) / 1_000_000) * 100;
  const estimatedCostCents = Math.max(1, Math.ceil(rawCents));
  return { inputTokens, outputTokens, estimatedCostCents };
}

// ---------------------------------------------------------------------------
// Shared low-level helpers
// ---------------------------------------------------------------------------

/** Common timeout wrapping for outbound provider HTTP calls. */
export function withTimeout(promise: Promise<Response>, ms: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`AI provider request timed out after ${ms}ms`)), ms);
    promise
      .then((r) => {
        clearTimeout(t);
        resolve(r);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

/** Risk-averse JSON extraction: find the first {...} block and parse it. */
export function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Stateless HTTP POST helper shared by both providers. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number
): Promise<{ status: number; text: string }> {
  let res: Response;
  try {
    res = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      timeoutMs
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`AI provider network error: ${msg}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const detail = text ? text.slice(0, 500) : `HTTP ${res.status}`;
    throw new Error(`AI provider API error ${res.status}: ${detail}`);
  }
  return { status: res.status, text };
}
