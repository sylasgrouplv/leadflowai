/**
 * AI context builder — assembles the AiRequest payload for a business
 * straight from the database (services, knowledge base, hours, service area,
 * policies). The AI provider answers ONLY from this context (spec safety
 * rule 1: never fabricate business info).
 */
import * as repo from "../db/repo";
import type { AiMessage, AiRequest } from "../integrations/types";
import type { conversations, leads } from "../db/schema";

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** The business hours shape the provider expects. */
export type HoursMap = AiRequest["hours"];

export async function buildAiRequest(
  businessId: string,
  message: string,
  history: AiMessage[]
): Promise<AiRequest> {
  const [business, services, knowledge] = await Promise.all([
    repo.getBusinessById(businessId),
    repo.listServices(businessId),
    repo.listKnowledge(businessId),
  ]);
  if (!business) throw new Error("Business not found");

  const hours = safeJson<HoursMap>(business.hoursJson, {});
  const serviceArea = safeJson<{ zipCodes: string[]; cities: string[] }>(business.serviceAreaJson, {
    zipCodes: [],
    cities: [],
  });
  const policies = safeJson<AiRequest["policies"]>(business.policiesJson, {
    cancellationPolicy: "",
    financing: "",
    promotions: "",
    welcomeMessage: "",
  });
  const aiConfig = await repo.getAiConfig(businessId);

  return {
    businessId: business.id,
    businessName: business.name,
    message,
    history,
    services: services.map((s) => ({ name: s.name, description: s.description ?? "", priceCents: s.priceCents })),
    knowledge: knowledge.map((k) => ({ kind: k.kind, question: k.question ?? "", answer: k.answer })),
    policies,
    hours,
    serviceArea,
    escalation: { sensitivity: aiConfig.escalationSensitivity, keywords: aiConfig.escalationKeywords },
  };
}

/** Conversation history in the shape the provider expects (most recent last). */
export async function buildHistory(businessId: string, conversationId: string): Promise<AiMessage[]> {
  const messages = await repo.listMessages(businessId, conversationId);
  return messages
    .filter((m) => m.sender === "ai" || m.sender === "lead")
    .map((m) => ({ role: m.sender === "ai" ? ("assistant" as const) : ("user" as const), content: m.body }));
}

export type { conversations, leads };
