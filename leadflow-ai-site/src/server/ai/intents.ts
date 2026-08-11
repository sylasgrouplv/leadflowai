/**
 * AI Orchestrator — intent taxonomy and confidence levels (spec §2, §26).
 *
 * The 13 intents are the orchestrator's routing vocabulary. Every customer
 * message is classified into exactly one intent; the confidence level (HIGH /
 * MEDIUM / LOW) is recorded with the classification in agent_actions and
 * drives the never-fabricate safety rule (§26: LOW → clarify or escalate).
 */
export const INTENTS = [
  "GENERAL_QUESTION",
  "NEW_LEAD",
  "SERVICE_INQUIRY",
  "PRICE_INQUIRY",
  "APPOINTMENT_REQUEST",
  "APPOINTMENT_CHANGE",
  "APPOINTMENT_CANCEL",
  "FOLLOW_UP",
  "COMPLAINT",
  "REFUND_REQUEST",
  "HUMAN_REQUEST",
  "EMERGENCY",
  "UNKNOWN",
] as const;

export type Intent = (typeof INTENTS)[number];

export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const INTENT_LABELS: Record<Intent, string> = {
  GENERAL_QUESTION: "General question",
  NEW_LEAD: "New lead",
  SERVICE_INQUIRY: "Service inquiry",
  PRICE_INQUIRY: "Price inquiry",
  APPOINTMENT_REQUEST: "Appointment request",
  APPOINTMENT_CHANGE: "Appointment change",
  APPOINTMENT_CANCEL: "Appointment cancel",
  FOLLOW_UP: "Follow-up",
  COMPLAINT: "Complaint",
  REFUND_REQUEST: "Refund request",
  HUMAN_REQUEST: "Human request",
  EMERGENCY: "Emergency",
  UNKNOWN: "Unknown",
};

export function isIntent(value: string): value is Intent {
  return (INTENTS as readonly string[]).includes(value);
}
