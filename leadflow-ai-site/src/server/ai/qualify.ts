/**
 * Qualification engine — the AI action framework in practice.
 *
 * Spec §26: agents call VALIDATED backend functions only (never direct DB
 * writes). Every mutation below goes through a named action function that
 * validates its input with zod, applies the change through the repo (tenant-
 * scoped by businessId), and logs an agent_actions row (safety rule 9).
 *
 * The engine is deterministic and conservative:
 *   - it only writes fields it can extract with high confidence,
 *   - it never downgrades a status or score already collected,
 *   - everything it needs comes from the message text + business config.
 */

import { z } from "zod";
import * as repo from "../db/repo";
import type { LeadScore, LeadStatus } from "../db/schema";
import { callAiTool } from "./tools/registry";
import type { UrgencyLevel } from "./tools/score";

/** A lead row as returned by repo (TS treats repo lookups as non-null; keep an explicit nullable alias). */
export type LeadRow = NonNullable<Awaited<ReturnType<typeof repo.getLeadById>>>;

/** Lead status transitions live in status.ts (shared with the tool registry). */
export { setStatusAction } from "./status";

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const URGENCY_WORDS = [
  "emergency", "urgent", "asap", "leaking", "flood", "flooded", "broken", "no heat", "no ac", "not cooling",
  "not heating", "right away", "tonight", "today", "can't wait", "cannot wait", "immediate", "smoke",
];
/** Safety-critical signals → rubric urgency "emergency" (25/25). */
const EMERGENCY_WORDS = ["emergency", "gas leak", "carbon monoxide", "smoke", "fire", "flood", "flooded", "burst pipe", "water everywhere", "electrical hazard"];
/** Time-flexible signals → rubric urgency "soon" (10/25). */
const SOON_WORDS = ["tomorrow", "this week", "next week", "in a few days", "later this", "sometime soon", "soon"];
const BOOKING_WORDS = ["book", "booking", "schedule", "appointment", "come out", "come by", "when can", "what time", "visit", "set up a time", "availability", "available"];

/** Keyword -> service name hints (falls back to fuzzy match against the business's services). */
const SERVICE_HINTS: Record<string, string[]> = {
  "ac": ["ac"], "air conditioning": ["ac"], "cooling": ["ac"], "hvac": ["ac", "furnace"],
  "furnace": ["furnace"], "heater": ["furnace"], "heating": ["furnace"], "heat": ["furnace"],
  "thermostat": ["smart thermostat"], "duct": ["duct"], "tune-up": ["tune-up"], "tune up": ["tune-up"],
  "installation": [], "install": [], "repair": [], "clean": [],
};

const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}|\b\d{10}\b/;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;

const NAME_PATTERNS: Array<RegExp> = [
  /my name is ([a-z][a-z' -]{1,40})/i,
  /i'?m ([a-z][a-z' -]{1,40})/i,
  /this is ([a-z][a-z' -]{1,40})/i,
  /it'?s ([a-z][a-z' -]{1,40})/i,
  /name'?s ([a-z][a-z' -]{1,40})/i,
];

/** Placeholder names assigned when a lead is auto-created by a channel (e.g.
 * the website widget's "Website Visitor") — real names from chat may replace
 * them. */
export const PLACEHOLDER_NAME_RE = /^(website|visitor|new|lead|web|anonymous)$/i;
/** Location/connective false starts that must never be taken as a first name
 * (mirrors memory.ts — kept local to avoid a circular import). */
const BAD_NAME_START_RE = /^(in|at|near|from|the|a|my|our|i|im|located|around|on|for|please|can|could|need|have|is|am)$/i;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1));
}

export interface ExtractedInfo {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  serviceRequested?: string;
  location?: string;
  urgent: boolean;
  bookingIntent: boolean;
  hasContact: boolean;
  /** Rubric urgency level (spec §9): emergency 25, urgent 20, soon 10, none 5. */
  urgencyLevel: UrgencyLevel;
  /** Rubric appointment intent: ready 15 (explicit booking ask), considering 8, none 0. */
  appointmentIntent: "ready" | "considering" | "none";
}

export function extractInfo(lead: LeadRow | null, text: string, services: { name: string }[]): ExtractedInfo {
  const out: ExtractedInfo = {
    urgent: false,
    bookingIntent: false,
    hasContact: !!lead?.phone || !!lead?.email,
    urgencyLevel: "none",
    appointmentIntent: "none",
  };
  const lower = text.toLowerCase();

  // Urgency + booking intent.
  out.urgent = URGENCY_WORDS.some((w) => lower.includes(w));
  out.bookingIntent = BOOKING_WORDS.some((w) => lower.includes(w));
  if (EMERGENCY_WORDS.some((w) => lower.includes(w))) out.urgencyLevel = "emergency";
  else if (out.urgent) out.urgencyLevel = "urgent";
  else if (SOON_WORDS.some((w) => lower.includes(w))) out.urgencyLevel = "soon";
  if (out.bookingIntent) out.appointmentIntent = "ready";
  else if (/(availability|when can|what time|open (times|slots)|set up a time|schedule)/i.test(lower)) out.appointmentIntent = "considering";

  // Phone / email.
  const phone = text.match(PHONE_RE);
  if (phone && !lead?.phone) out.phone = phone[0].replace(/[^\d+]/g, "");
  const email = text.match(EMAIL_RE);
  if (email && !lead?.email) out.email = email[0].toLowerCase();
  if (out.phone || out.email) out.hasContact = true;

  // Name — only replace a missing/placeholder FIRST name. A real collected
  // name is never overwritten: a placeholder last name ("Visitor") alone must
  // not re-open extraction, or "I'm in Adrian" would clobber a real first name
  // with "in". Location/connective false starts are rejected (same guard as
  // memory.ts) so "I'm in Springfield" never yields a first name of "in".
  if (!lead?.firstName || PLACEHOLDER_NAME_RE.test(lead.firstName)) {
    for (const re of NAME_PATTERNS) {
      const m = text.match(re);
      if (m) {
        // Stop at connective words so "my name is Dana and my phone is…"
        // captures only the name, not the rest of the sentence.
        const stop = /(\s+(?:and|but|my|i'?m|i\s|at|in|near|located|on|for|please|thanks|thank|can|could|need|have)\b)/i;
        const name = m[1].trim().split(stop)[0];
        const parts = name.split(/\s+/);
        const first = parts[0].replace(/[^a-zA-Z' -]/g, "");
        if (!BAD_NAME_START_RE.test(first)) {
          out.firstName = first;
          if (parts.length > 1) out.lastName = parts.slice(1).join(" ").replace(/[^a-zA-Z' -]/g, "");
        }
        break;
      }
    }
  }

  // Location — zip code, city from service area, or "in <place>".
  const zip = text.match(ZIP_RE);
  if (zip && !lead?.location) out.location = zip[0];
  if (!out.location && !lead?.location) {
    const city = services.length ? findCity(text) : null;
    if (city) out.location = city;
  }
  if (!out.location && !lead?.location) {
    const m = text.match(/\b(?:in|near|around|located in)\s+([a-z][a-z]+(?: [a-z]+){0,3})/i);
    if (m && !m[1].toLowerCase().match(/^(the|a|my|our)$/)) out.location = m[1].trim();
  }

  // Service — fuzzy match against the business's service names, then hints.
  if (!lead?.serviceRequested) {
    const toks = words(text);
    let match: string | undefined;
    // 1) Phrase priority: "repair", "tune-up", "install" disambiguate families
    //    (AC Repair vs AC Tune-Up) before falling back to token matching.
    for (const p of ["tune-up", "tune up", "repair", "install", "cleaning", "maintenance", "thermostat"]) {
      if (lower.includes(p)) {
        const m = services.find((sv) => sv.name.toLowerCase().includes(p));
        if (m) {
          match = m.name;
          break;
        }
      }
    }
    // 2) Token match against service names (longest name wins on ties).
    if (!match) {
      for (const sv of services) {
        const st = new Set(sv.name.toLowerCase().split(/\s+/));
        let hits = 0;
        for (const t of toks) if (st.has(t)) hits += 1;
        if (hits >= 1 && (!match || sv.name.length > match.length)) match = sv.name;
      }
    }
    if (!match) {
      for (const [kw, hints] of Object.entries(SERVICE_HINTS)) {
        if (lower.includes(kw) && hints.length) {
          match = services.find((sv) => hints.some((h) => sv.name.toLowerCase().includes(h)))?.name;
          if (match) break;
        }
      }
    }
    if (match) out.serviceRequested = match;
  }

  return out;
}

function findCity(text: string): string | null {
  // Callers pass service-area city names via services-adjacent lookup; simple
  // heuristic: "in Springfield" patterns are handled by the generic location
  // regex, so this stays conservative.
  return null;
}

// ---------------------------------------------------------------------------
// Validated action functions (spec §26) — every one logs an agent_actions row.
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().min(1).max(max).optional();

const leadPatchSchema = z.object({
  firstName: text(100),
  lastName: text(100),
  phone: text(30),
  email: z.string().email().max(254).optional().or(z.literal("")),
  serviceRequested: text(120),
  location: text(120),
  estimatedValueCents: z.number().int().min(0).max(100_000_000).optional(),
});

export async function updateLeadAction(
  businessId: string,
  leadId: string,
  patch: z.infer<typeof leadPatchSchema>
): Promise<LeadRow | null> {
  const parsed = leadPatchSchema.safeParse(patch);
  if (!parsed.success) return repo.getLeadById(businessId, leadId); // invalid -> no-op, nothing written
  const updated = await repo.updateLead(businessId, leadId, parsed.data as never);
  if (updated) {
    await repo.logAgentAction(businessId, {
      agent: "qualification",
      action: "update_lead",
      leadId,
      input: parsed.data,
      result: { ok: true },
      success: true,
    });
  }
  return updated;
}

export async function scoreLeadAction(
  businessId: string,
  leadId: string,
  score: LeadScore
): Promise<LeadRow | null> {
  if (!z.enum(["hot", "warm", "cold"]).safeParse(score).success) return repo.getLeadById(businessId, leadId);
  const updated = await repo.updateLead(businessId, leadId, { score });
  if (updated) {
    await repo.logAgentAction(businessId, {
      agent: "qualification",
      action: "score_lead",
      leadId,
      input: { score },
      result: { ok: true },
      success: true,
    });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Orchestration: run qualification on a fresh lead message.
// ---------------------------------------------------------------------------

export interface QualificationResult {
  lead: LeadRow | null;
  changed: string[];
}

export async function qualifyLead(
  businessId: string,
  lead: LeadRow,
  text: string
): Promise<QualificationResult> {
  const services = await repo.listServices(businessId);
  const info = extractInfo(lead, text, services);
  const changed: string[] = [];
  const ctx = { businessId, agent: "qualification" };

  // 1) Collect contact / lead info (tool: update_lead — validated + audited).
  // NOTE: the tool registry's update_lead schema uses snake_case keys
  // (first_name, service_requested, …); camelCase keys would be stripped by
  // zod validation and the patch would silently write nothing.
  const patch: Record<string, string | number> = {};
  if (info.firstName) patch.first_name = info.firstName;
  if (info.lastName) patch.last_name = info.lastName;
  if (info.phone) patch.phone = info.phone;
  if (info.email) patch.email = info.email;
  if (info.serviceRequested) patch.service_requested = info.serviceRequested;
  if (info.location) patch.location = info.location;
  if (Object.keys(patch).length) {
    try {
      const updated = (await callAiTool("update_lead", ctx, { lead_id: lead.id, ...patch })) as LeadRow | null;
      if (updated) {
        lead = updated;
        changed.push(...Object.keys(patch));
      }
    } catch (e) {
      console.error("[qualify] update_lead failed:", e); // never break the conversation
    }
  }

  // 2) Estimated value from the matched service (only when the lead has none).
  if (lead.estimatedValueCents === 0 && lead.serviceRequested) {
    const sv = services.find((s) => s.name.toLowerCase() === lead.serviceRequested?.toLowerCase());
    if (sv && sv.priceCents > 0) {
      try {
        await callAiTool("update_lead", ctx, { lead_id: lead.id, estimated_value_cents: sv.priceCents });
        changed.push("estimatedValueCents");
      } catch (e) {
        console.error("[qualify] update_lead(value) failed:", e);
      }
    }
  }

  // 3) Score via the 0–100 rubric (tool: score_lead — spec §9–11). The Lead
  //    Qualification Agent populates the rubric inputs from the extracted info;
  //    the rubric result (score_value + classification + display badge) is
  //    persisted by the tool itself.
  if (lead.id) {
    try {
      const scoring = (await callAiTool("score_lead", ctx, {
        lead_id: lead.id,
        service: lead.serviceRequested || null,
        location: lead.location || null,
        urgency: info.urgencyLevel,
        purchase_intent: info.bookingIntent ? "ready" : info.urgent ? "strong" : info.hasContact ? "researching" : "low",
        appointment_intent: info.appointmentIntent,
      })) as { score: number; classification: string; display_score: string };
      if (scoring?.display_score) changed.push("score");
    } catch (e) {
      console.error("[qualify] score_lead failed:", e); // fall back to no-op, never break the conversation
    }
  }

  // 4) Status (tool: set_lead_status) — progression only.
  const serviceKnown = !!lead.serviceRequested;
  const hasName = !!lead.firstName;
  const hasLocation = !!lead.location;
  let status: LeadStatus | null = null;
  if (hasName && info.hasContact && serviceKnown && hasLocation) status = "qualified";
  else if (info.hasContact || (serviceKnown && hasLocation)) status = "contacted";
  if (status && status !== lead.status) {
    try {
      const updated = (await callAiTool("set_lead_status", ctx, { lead_id: lead.id, status })) as LeadRow | null;
      if (updated) {
        lead = updated;
        changed.push("status");
      }
    } catch (e) {
      console.error("[qualify] set_lead_status failed:", e);
    }
  }

  return { lead, changed };
}
