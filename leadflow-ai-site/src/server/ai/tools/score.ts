/**
 * Lead scoring rubric (spec §9–11) — the 0–100 qualification model behind the
 * `score_lead` tool.
 *
 *   Urgency         0–25: Emergency 25, Urgent 20, Soon 10, None 5
 *   Service fit     0–20: Exact 20, Related 10, Not offered 0
 *   Location        0–20: Inside 20, Borderline 10, Outside 0
 *   Purchase intent 0–20: Ready 20, Strong 15, Researching 8, Low 3
 *   Appointment     0–15: Ready 15, Considering 8, None 0
 *
 * Classification: 80–100 HOT, 50–79 WARM, 0–49 COLD. Outside service area →
 * UNQUALIFIED regardless of other scores. Escalation context → HUMAN_REVIEW.
 *
 * Pure functions only — no DB access here (the tool handler persists the
 * result). Exported separately so tests can exercise the rubric directly.
 */
import type { LeadClassification, LeadScore } from "../../db/schema";

export type UrgencyLevel = "emergency" | "urgent" | "soon" | "none";
export type PurchaseIntent = "ready" | "strong" | "researching" | "low";
export type AppointmentIntent = "ready" | "considering" | "none";
export type ServiceFit = "exact" | "related" | "not_offered" | "unknown";
export type LocationFit = "inside" | "borderline" | "outside" | "unknown";

export const URGENCY_POINTS: Record<UrgencyLevel, number> = {
  emergency: 25,
  urgent: 20,
  soon: 10,
  none: 5,
};
export const SERVICE_FIT_POINTS: Record<ServiceFit, number> = {
  exact: 20,
  related: 10,
  not_offered: 0,
  unknown: 0,
};
export const LOCATION_POINTS: Record<LocationFit, number> = {
  inside: 20,
  borderline: 10,
  outside: 0,
  unknown: 10,
};
export const PURCHASE_INTENT_POINTS: Record<PurchaseIntent, number> = {
  ready: 20,
  strong: 15,
  researching: 8,
  low: 3,
};
export const APPOINTMENT_INTENT_POINTS: Record<AppointmentIntent, number> = {
  ready: 15,
  considering: 8,
  none: 0,
};

export interface LeadScoreInput {
  urgency: UrgencyLevel;
  serviceFit: ServiceFit;
  locationFit: LocationFit;
  purchaseIntent: PurchaseIntent;
  appointmentIntent: AppointmentIntent;
  /** Escalation context (spec §18): complaint/angry/refund/emergency etc. */
  escalation?: string | null;
}

export interface LeadScoreComponents {
  urgency: number;
  serviceFit: number;
  locationFit: number;
  purchaseIntent: number;
  appointmentIntent: number;
}

export interface LeadScoreResult {
  score: number;
  classification: LeadClassification;
  components: LeadScoreComponents;
  reasoningSummary: string;
  recommendedNextAction: string;
  /** The display badge mapping (keeps the existing hot/warm/cold UI working). */
  displayScore: LeadScore;
}

/** Spec §9: outside service area → UNQUALIFIED regardless of other scores. */
export function isOutsideArea(fit: LocationFit): boolean {
  return fit === "outside";
}

export function classifyLeadScore(score: number): LeadClassification {
  if (score >= 80) return "HOT";
  if (score >= 50) return "WARM";
  return "COLD";
}

/** Map the rubric classification onto the existing hot/warm/cold display field. */
export function displayScoreFor(classification: LeadClassification): LeadScore {
  switch (classification) {
    case "HOT":
      return "hot";
    case "WARM":
      return "warm";
    case "HUMAN_REVIEW":
      return "hot"; // needs human attention — surface at the top of the funnel
    case "UNQUALIFIED":
    case "COLD":
      return "cold";
  }
}

const RANK: Record<LeadScore, number> = { cold: 1, warm: 2, hot: 3 };

/** Never downgrade the display badge (existing behavior: hot stays hot). */
export function mergeDisplayScore(current: LeadScore | null | undefined, next: LeadScore): LeadScore {
  const cur = current && RANK[current] ? RANK[current] : 0;
  return RANK[next] > cur ? next : (current as LeadScore) ?? "cold";
}

export function recommendedNextActionFor(classification: LeadClassification): string {
  switch (classification) {
    case "HOT":
      return "Contact the lead immediately — they are ready to book. Confirm appointment details and lock in a time.";
    case "WARM":
      return "Respond within a few hours; offer specific appointment times and continue qualification.";
    case "COLD":
      return "Keep in the follow-up sequence; ask what would help them decide and stay top-of-mind.";
    case "UNQUALIFIED":
      return "Do not pursue — outside the service area. Optionally log the location for future service-area expansion.";
    case "HUMAN_REVIEW":
      return "Hand to a human immediately — review the conversation and respond personally. Do not let the AI continue alone.";
  }
}

export function computeLeadScore(input: LeadScoreInput): LeadScoreResult {
  const { urgency, serviceFit, locationFit, purchaseIntent, appointmentIntent, escalation } = input;

  const components: LeadScoreComponents = {
    urgency: URGENCY_POINTS[urgency],
    serviceFit: SERVICE_FIT_POINTS[serviceFit],
    locationFit: LOCATION_POINTS[locationFit],
    purchaseIntent: PURCHASE_INTENT_POINTS[purchaseIntent],
    appointmentIntent: APPOINTMENT_INTENT_POINTS[appointmentIntent],
  };
  const total = components.urgency + components.serviceFit + components.locationFit + components.purchaseIntent + components.appointmentIntent;

  // UNQUALIFIED wins over everything (spec §9: "regardless of other scores").
  let classification: LeadClassification;
  if (isOutsideArea(locationFit)) {
    classification = "UNQUALIFIED";
  } else if (escalation && escalation.trim().length > 0) {
    classification = "HUMAN_REVIEW";
  } else {
    classification = classifyLeadScore(total);
  }

  const reasoningSummary = [
    `Urgency: ${urgency} (${components.urgency}/25)`,
    `Service fit: ${serviceFit} (${components.serviceFit}/20)`,
    `Location: ${locationFit} (${components.locationFit}/20)`,
    `Purchase intent: ${purchaseIntent} (${components.purchaseIntent}/20)`,
    `Appointment intent: ${appointmentIntent} (${components.appointmentIntent}/15)`,
    escalation ? `Escalation context: ${escalation}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  return {
    score: total,
    classification,
    components,
    reasoningSummary,
    recommendedNextAction: recommendedNextActionFor(classification),
    displayScore: displayScoreFor(classification),
  };
}
