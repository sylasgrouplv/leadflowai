/**
 * AI Agent Brain — Mock LLM provider (spec §42, owner decision: mock today,
 * real provider swaps in later via AI_PROVIDER env — config-only).
 *
 * Implements the orchestrator provider contract behind the same interface a
 * real LLM (OpenAI/Anthropic) will use:
 *
 *   classifyIntent(message, context)  -> one of the 13 intents + confidence
 *   generateReply(prompt, context)    -> KB-grounded reply + answer confidence
 *
 * The mock is deterministic and conservative:
 *   - intent detection is rule-based over the 13-intent taxonomy (spec §2),
 *   - replies come ONLY from the provided business context (services, KB,
 *     policies, hours, service area) + conversation memory (spec §5 priority:
 *     exact config → KB → approved service info → general conversational),
 *   - never fabricates pricing/availability/facts; LOW confidence is returned
 *     and the orchestrator clarifies or escalates (spec §26),
 *   - extraction/qualification logic is reused from qualify.ts (same source of
 *     truth as the qualification agent).
 */
import type {
  AiProvider,
  AiRequest,
  AiResponse,
  AiIntentInput,
  AiIntentResult,
  AiGenerateInput,
  AiGeneratedReply,
} from "./types";
import type { Intent, ConfidenceLevel } from "../ai/intents";
import type { ConversationMemory } from "../ai/memory";
import { PLACEHOLDER_NAME_RE } from "../ai/qualify";

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

// ---------------------------------------------------------------------------
// Intent classification — rule-based, spec §2 (13 intents).
// Order matters: safety-critical and specific intents are checked before
// general ones. Every intent must be detectable by at least one phrase.
// ---------------------------------------------------------------------------

const EMERGENCY_RE = /\b(emergency|gas leak|carbon monoxide|fire|smoke|flood(ed)?|burst pipe|water everywhere|electrical hazard|dangerous)\b/;
const HUMAN_REQ_RE = /\b(talk|speak|chat|connect|put me)\b.{0,24}\b(human|person|representative|agent|guy|someone|manager)\b|\b(human|person|representative|manager)\b.{0,24}\b(talk|speak|chat|help me now)\b/i;
const REFUND_RE = /\b(refund|money back|my money back|chargeback|charge back|reimburse)\b/i;
const COMPLAINT_RE = /\b(angry|furious|upset|terrible|horrible|awful|worst|unacceptable|complain|complaint|rude|ruined|dissatisfied|damaged (my|our|the|your|his|her)|broke (my|our|the)|scratched (my|our|the)|dented (my|our|the)|sloppy|unprofessional)\b/i;
const CANCEL_RE = /\b(cancel(ling|l)? (my|the|this) (appointment|booking|visit|reservation)|i want to cancel|need to cancel|cancel (my|this))\b/i;
const CHANGE_RE = /\b(reschedule|change (my|the) (appointment|time|visit|booking)|move (my|the) (appointment|visit)|postpone|push (it )?(back|out)|switch (my|the) (appointment|time))\b/i;
const PRICE_RE = /\b(price|pricing|cost|how much|quote|charge|what (do|does).{0,16}(cost|charge)|estimate for)\b/i;
const BOOK_RE = /\b(book|schedule|appointment|availability|available|when can|come (out|by)|visit|set up a time|reserve|slot|can (you|someone|a tech) come)\b/i;
const FOLLOWUP_RE = /\b(follow[- ]?up|following up|checking in|any update|status of (my|the)|have you heard|just checking|waiting to hear)\b/i;
const HOURS_RE = /\b(hours|open|close|closed|what time (are|do|is) you|when (are|do) you (open|close|work)|business (hours|time))\b/;
const AREA_RE = /\b(service area|do you serve|where (are|do) you (located|serve)|zip codes?|what areas|locations?|coverage)\b/i;
const FINANCE_RE = /\b(financ\w*|payment plan|installments?|credit|afford|monthly payments?)\b/i;
const CANCEL_POLICY_RE = /\b(cancellation policy|cancel(l)?ation (fee|notice)|reschedule policy)\b/i;
const GREETING_RE = /^(hi|hello|hey|good (morning|afternoon|evening))[!. ]*$/i;

/** The customer is answering a qualification question (name/location/contact). */
const INFO_ANSWER_RE =
  /(my name is|name'?s |this is |i'?m |i am |my phone|my email|phone (is|number)|email (is|address)|call me|text me|reach me|zip( code)? is|located in|i live in|my number|address is)/i;

/** Generic question start — anything unanswered that reads like a question. */
const QUESTION_START_RE = /^(do|can|does|are|is|what|how|when|where|who|why|would|could|should)\b/i;

/** Generic tokens that never discriminate one question from another. */
const KB_STOP_WORDS = new Set([
  "how", "much", "does", "do", "a", "an", "the", "is", "are", "you", "i", "what", "cost", "price", "can", "me", "my",
  "for", "of", "to", "and", "or", "we", "your", "get", "have", "would", "could", "should", "it", "in", "on", "about", "with",
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s$%]/g, " ").split(/\s+/).filter((w) => w.length > 1);
}

/** Service match: ≥1 token overlap (longest name wins), like qualify.ts. */
function matchService(services: { name: string }[], message: string): { name: string } | null {
  const toks = new Set(tokenize(message));
  let match: { name: string } | null = null;
  for (const sv of services) {
    const st = new Set(tokenize(sv.name));
    let hits = 0;
    for (const t of toks) if (st.has(t)) hits += 1;
    if (hits >= 1 && (!match || sv.name.length > match.name.length)) match = sv;
  }
  return match;
}

export class MockAiProvider implements AiProvider {
  readonly name = "mock-ai";

  async classifyIntent(input: AiIntentInput): Promise<AiIntentResult> {
    const { message, services } = input;
    const lower = message.toLowerCase();

    if (EMERGENCY_RE.test(lower)) return { intent: "EMERGENCY", confidence: "HIGH" };
    if (HUMAN_REQ_RE.test(lower)) return { intent: "HUMAN_REQUEST", confidence: "HIGH" };
    if (REFUND_RE.test(lower)) return { intent: "REFUND_REQUEST", confidence: "HIGH" };
    if (COMPLAINT_RE.test(lower)) return { intent: "COMPLAINT", confidence: "HIGH" };
    if (CANCEL_RE.test(lower)) return { intent: "APPOINTMENT_CANCEL", confidence: "HIGH" };
    if (CHANGE_RE.test(lower)) return { intent: "APPOINTMENT_CHANGE", confidence: "HIGH" };
    // Follow-up checks BEFORE price: "checking in on my quote" is a follow-up,
    // not a new price question.
    if (FOLLOWUP_RE.test(lower)) return { intent: "FOLLOW_UP", confidence: "MEDIUM" };
    if (PRICE_RE.test(lower)) return { intent: "PRICE_INQUIRY", confidence: "HIGH" };
    // Hours / service area / financing / cancellation policy / greeting.
    if (HOURS_RE.test(lower) || AREA_RE.test(lower) || FINANCE_RE.test(lower) || CANCEL_POLICY_RE.test(lower) || GREETING_RE.test(message.trim())) {
      return { intent: "GENERAL_QUESTION", confidence: "MEDIUM" };
    }
    if (BOOK_RE.test(lower)) {
      // "tomorrow / next week / today" plus a booking phrase → clear request.
      const when = /\b(tomorrow|today|tonight|next (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|month)|this (week|weekend)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
      return { intent: "APPOINTMENT_REQUEST", confidence: when.test(lower) ? "HIGH" : "MEDIUM" };
    }
    if (matchService(services, message)) return { intent: "SERVICE_INQUIRY", confidence: "HIGH" };
    // First-contact need without any service/general signal yet.
    if (/(need|have|want|looking for|help with|issue with|problem with)/.test(lower) && !input.memory.customerName) {
      return { intent: "NEW_LEAD", confidence: "MEDIUM" };
    }
    // Any other well-formed question is a general question (answered from
    // hours/area/policies/KB — the generator never fabricates).
    if (QUESTION_START_RE.test(lower)) return { intent: "GENERAL_QUESTION", confidence: "MEDIUM" };
    // The customer is answering our qualification questions (name, location,
    // contact) — keep the lead flow going rather than classifying as UNKNOWN
    // and escalating mid-collection (spec §8: don't re-ask; continue collecting).
    if (INFO_ANSWER_RE.test(lower)) {
      return { intent: input.memory.service ? "SERVICE_INQUIRY" : "NEW_LEAD", confidence: "MEDIUM" };
    }
    return { intent: "UNKNOWN", confidence: "LOW" };
  }

  // -------------------------------------------------------------------------
  // Reply generation — grounded ONLY in the provided context + memory.
  // -------------------------------------------------------------------------

  async generateReply(input: AiGenerateInput): Promise<AiGeneratedReply> {
    const { intent, message, memory, services, knowledge, policies, serviceArea, hasAppointment } = input;
    const lower = message.toLowerCase();

    switch (intent) {
      case "EMERGENCY": {
        const faq = findKb(knowledge, /\b(emergency|call|phone)\b/i);
        const reply =
          faq?.answer ??
          "Please call us right away so we can get help to you — I'm also notifying the team now. (I'm the AI receptionist.)";
        return { reply, answerConfidence: "HIGH" };
      }
      case "COMPLAINT":
      case "REFUND_REQUEST":
      case "HUMAN_REQUEST":
        // The orchestrator replaces this with the spec escalation message; this
        // is only a fallback so the provider contract always returns a reply.
        return { reply: ESCALATION_REPLY, answerConfidence: "HIGH" };
      case "APPOINTMENT_CANCEL":
        // HIGH-RISK tool (spec §24): the AI has no cancel tool — escalate.
        return { reply: CANCEL_ESCALATION_REPLY, answerConfidence: "HIGH" };
      case "PRICE_INQUIRY": {
        // Spec §5 priority: KB FAQ first, then approved service pricing, and
        // never invent — scenario 3: no configured price → estimate phrase.
        const faq = findKbQuestion(knowledge, message);
        if (faq) return { reply: faq.answer, answerConfidence: "HIGH" };
        const matched = matchServiceForPrice(services, message, memory);
        if (matched && matched.priceCents > 0) {
          return {
            reply: `${matched.name}: ${MONEY.format(matched.priceCents / 100)}. Want me to set up a time for us to come out?`,
            answerConfidence: "HIGH",
          };
        }
        if (matched) {
          return {
            reply: `The cost of a ${matched.name} depends on the details of your home. I can have the team provide you with an estimate.`,
            answerConfidence: "MEDIUM",
          };
        }
        return { reply: PRICE_ESTIMATE_REPLY, answerConfidence: "LOW" };
      }
      case "APPOINTMENT_REQUEST": {
        const service = memoryService(services, memory);
        if (service) {
          return {
            reply: `I'd be happy to find you a time for the ${service.name}. Here are the next open times I can offer — which works best for you?`,
            answerConfidence: "HIGH",
          };
        }
        return {
          reply: "I'd be happy to find you a time. Which service do you need, and what day works best for you?",
          answerConfidence: "MEDIUM",
        };
      }
      case "APPOINTMENT_CHANGE":
        return {
          reply: "I can help with that. Which appointment would you like to move, and what day or time works better for you?",
          answerConfidence: "MEDIUM",
        };
      case "FOLLOW_UP":
        if (hasAppointment) {
          return {
            reply: "I've checked — you have an appointment on the calendar. If you need to change it, just let me know.",
            answerConfidence: "HIGH",
          };
        }
        return {
          reply: "I've checked — I don't see an appointment on file yet. Would you like me to find a time for you?",
          answerConfidence: "MEDIUM",
        };
      case "SERVICE_INQUIRY":
      case "NEW_LEAD":
        return qualificationPrompt(input);
      case "GENERAL_QUESTION":
        return generalAnswer(input);
      case "UNKNOWN":
      default:
        // Spec §3 rule 1: never fabricate. The orchestrator decides clarify vs
        // escalate from sensitivity; this is the never-fabricate phrasing.
        return { reply: UNKNOWN_CLARIFY_REPLY, answerConfidence: "LOW" };
    }
  }

  // Legacy single-shot path — kept for compatibility (engine now routes through
  // the orchestrator, which uses classifyIntent + generateReply).
  async respond(req: AiRequest): Promise<AiResponse> {
    const cls = await this.classifyIntent({ message: req.message, businessName: req.businessName, services: req.services, memory: {} });
    const gen = await this.generateReply({
      businessId: req.businessId,
      businessName: req.businessName,
      message: req.message,
      intent: cls.intent,
      intentConfidence: cls.confidence,
      services: req.services,
      knowledge: req.knowledge,
      policies: req.policies,
      hours: req.hours,
      serviceArea: req.serviceArea,
      escalation: req.escalation ?? { sensitivity: "medium", keywords: [] },
      memory: {},
      lead: null,
      hasAppointment: false,
      conversation: { channel: "chat", status: "active" },
      history: req.history,
    });
    const intent: AiResponse["intent"] =
      cls.intent === "APPOINTMENT_REQUEST" || cls.intent === "APPOINTMENT_CHANGE" || cls.intent === "APPOINTMENT_CANCEL"
        ? "book"
        : ["COMPLAINT", "REFUND_REQUEST", "HUMAN_REQUEST", "EMERGENCY", "APPOINTMENT_CANCEL"].includes(cls.intent)
          ? "escalate"
          : cls.intent === "UNKNOWN"
            ? "unknown"
            : "answer";
    const confidence = cls.confidence === "HIGH" ? 0.9 : cls.confidence === "MEDIUM" ? 0.6 : 0.3;
    return { reply: gen.reply, intent, confidence };
  }
}

// ---------------------------------------------------------------------------
// Grounded helpers (never fabricate — answers only from provided context)
// ---------------------------------------------------------------------------

export const UNKNOWN_CLARIFY_REPLY =
  "I don't want to give you inaccurate information. I can have someone from the team confirm that for you.";
export const UNKNOWN_ESCALATION_REPLY =
  "I want to make sure you get the right answer, so I'm going to have someone from the team take a look at this. I've passed along the details you've provided.";
export const ESCALATION_REPLY =
  "I want to make sure you get the right answer, so I'm going to have someone from the team take a look at this. I've passed along the details you've provided.";
export const CANCEL_ESCALATION_REPLY =
  "I can't make changes to a booking directly, but I want to make sure this is handled right — I've passed it to the team and someone will confirm your cancellation.";
export const PRICE_ESTIMATE_REPLY =
  "The exact cost depends on the system and installation. I can have the team provide you with an estimate.";

function findKb(knowledge: AiGenerateInput["knowledge"], re: RegExp): { answer: string } | null {
  return knowledge.find((k) => re.test(`${k.question ?? ""} ${k.answer}`)) ?? null;
}

/** Meaningful tokens (stop words removed) for KB question matching. */
function meaningfulTokens(s: string): string[] {
  return tokenize(s).filter((t) => !KB_STOP_WORDS.has(t));
}

/**
 * KB FAQ match by question-token overlap (≥2 MEANINGFUL shared tokens).
 * Stop words are excluded so "How much does a new AC unit cost?" can never
 * surface the tune-up FAQ — only genuinely matching service words count.
 */
function findKbQuestion(knowledge: AiGenerateInput["knowledge"], message: string): { answer: string } | null {
  const toks = new Set(meaningfulTokens(message));
  for (const k of knowledge) {
    if (!k.question) continue;
    const qt = new Set(meaningfulTokens(k.question));
    let hits = 0;
    for (const t of toks) if (qt.has(t)) hits += 1;
    if (hits >= 2) return k;
  }
  return null;
}

/**
 * Price matching is deliberately stricter than general service matching:
 * ≥2 shared tokens (or an exact service-name phrase) so "a new AC unit" does
 * NOT surface "AC Repair: $189" (spec §35 scenario 3 — never invent pricing
 * for an unspecified/new system). The remembered service is only used when the
 * message mentions no service word at all ("what's the cost?" after we already
 * discussed AC repair).
 */
function matchServiceForPrice(
  services: { name: string; description: string; priceCents: number }[],
  message: string,
  memory: ConversationMemory
): { name: string; priceCents: number } | null {
  const lower = message.toLowerCase();
  const toks = new Set(tokenize(message));
  let best: { name: string; priceCents: number } | null = null;
  for (const sv of services) {
    const nameToks = tokenize(sv.name);
    const st = new Set(nameToks);
    let hits = 0;
    for (const t of toks) if (st.has(t)) hits += 1;
    const phrase = nameToks.length >= 2 && lower.includes(sv.name.toLowerCase());
    if ((hits >= 2 || phrase) && (!best || sv.name.length > best.name.length)) best = sv;
  }
  if (!best && memory.service && !SERVICE_REFERENCE_WORDS.test(lower)) {
    best = services.find((s) => s.name.toLowerCase() === memory.service!.toLowerCase()) ?? null;
  }
  return best;
}

/** Words that signal the customer is asking about a specific (possibly new) system. */
const SERVICE_REFERENCE_WORDS =
  /\b(ac|hvac|furnace|heater|heating|cooling|duct|tune|repair|install|installation|clean|thermostat|unit|system|replace|replacement|water|leak|plumbing|roof|siding|window|floor|door)\b/i;

function memoryService(services: { name: string }[], memory: ConversationMemory): { name: string } | null {
  if (memory.service) return services.find((s) => s.name.toLowerCase() === memory.service!.toLowerCase()) ?? null;
  return null;
}

/**
 * The lead's real first name from the reduced lead shape the provider sees
 * (never placeholder channel names, never from memory when empty).
 */
function realFirstNameFromLead(
  lead: { firstName: string; lastName: string } | null,
  memory: ConversationMemory
): string | null {
  const mem = memory.customerName?.split(/\s+/)[0];
  if (mem && mem.length > 1 && !PLACEHOLDER_NAME_RE.test(mem)) return mem;
  if (!lead) return null;
  const first = (lead.firstName ?? "").trim();
  if (!first || PLACEHOLDER_NAME_RE.test(first)) return null;
  return first;
}

// ---------------------------------------------------------------------------
// Qualification conversation (spec §8: collect only what's missing, one or two
// questions at a time, never re-ask what memory already holds).
// ---------------------------------------------------------------------------

function qualificationPrompt(input: AiGenerateInput): AiGeneratedReply {
  const { memory, lead, services, message } = input;
  const name = realFirstNameFromLead(lead, memory);
  const service = memory.service || lead?.serviceRequested || "";
  const location = memory.location || lead?.location || "";
  const hasContact = !!(lead?.phone || lead?.email);
  const problem = memory.problem || "";

  const intro =
    problem && !name && !/^(hi|hello|hey)\b/i.test(message)
      ? "I'm sorry you're dealing with that — I can help get this started."
      : "Thanks for reaching out!";

  if (!name) return { reply: `${intro} What's your name?`, answerConfidence: "HIGH" };
  if (!location) return { reply: `Thanks, ${name}. What city are you in?`, answerConfidence: "HIGH" };
  if (!service) {
    const list = services.slice(0, 5).map((s) => s.name).join(", ");
    return {
      reply: `Got it, ${name}. Which service do you need? We offer ${list}.`,
      answerConfidence: services.length ? "MEDIUM" : "LOW",
    };
  }
  if (!hasContact) {
    return {
      reply: `Thanks, ${name} — I've got you down for ${service}${location ? ` in ${location}` : ""}. What's the best phone number or email to reach you?`,
      answerConfidence: "HIGH",
    };
  }
  return {
    reply: `Thanks, ${name}! I've got everything I need for the ${service}${location ? ` in ${location}` : ""}. Would you like me to check our calendar for an appointment time?`,
    answerConfidence: "HIGH",
  };
}

// ---------------------------------------------------------------------------
// General questions — hours / area / financing / cancellation / KB FAQ / hello
// ---------------------------------------------------------------------------

function generalAnswer(input: AiGenerateInput): AiGeneratedReply {
  const { message, policies, hours, serviceArea, knowledge, businessName } = input;
  const lower = message.toLowerCase();

  if (HOURS_RE.test(lower)) {
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const lines: string[] = [];
    for (const d of days) {
      const h = hours[d];
      if (h && !h.closed) lines.push(`${d[0].toUpperCase()}${d.slice(1)}: ${h.open}–${h.close}`);
    }
    if (lines.length) {
      return { reply: `Our hours are: ${lines.join("; ")}. Would you like to book a visit?`, answerConfidence: "HIGH" };
    }
  }
  if (AREA_RE.test(lower)) {
    const places = [...serviceArea.cities, ...serviceArea.zipCodes];
    if (places.length) {
      return {
        reply: `We serve ${places.slice(0, 8).join(", ")}${places.length > 8 ? " and more" : ""}. Where are you located?`,
        answerConfidence: "HIGH",
      };
    }
    return { reply: "Let me confirm our service area for you — I can have the team reach out.", answerConfidence: "LOW" };
  }
  if (FINANCE_RE.test(lower)) {
    if (policies.financing) return { reply: `Here's what we offer: ${policies.financing}`, answerConfidence: "HIGH" };
    return { reply: "I'm not certain about financing options, but I can have someone from the team help you.", answerConfidence: "LOW" };
  }
  if (CANCEL_POLICY_RE.test(lower)) {
    if (policies.cancellationPolicy) return { reply: `Our cancellation policy: ${policies.cancellationPolicy}`, answerConfidence: "HIGH" };
    return { reply: "I can have someone from the team walk you through cancellation.", answerConfidence: "LOW" };
  }

  const faq = findKbQuestion(knowledge, message);
  if (faq) return { reply: faq.answer, answerConfidence: "HIGH" };

  if (GREETING_RE.test(message.trim())) {
    return {
      reply: `Hi there! Thanks for reaching out to ${businessName}. How can we help?`,
      answerConfidence: "HIGH",
    };
  }
  return { reply: UNKNOWN_CLARIFY_REPLY, answerConfidence: "LOW" };
}
