/**
 * Service-area verdict (spec §9) — shared by the orchestrator (outside area →
 * UNQUALIFIED) and the score_lead tool (location fit component).
 */

export type AreaVerdict = "inside" | "outside" | "unknown";

export function serviceAreaVerdict(location: string, area: { zipCodes: string[]; cities: string[] }): AreaVerdict {
  const loc = location.trim();
  if (!loc) return "unknown";
  // Zip code: unambiguous — inside only if listed.
  if (/^\d{5}(-\d{4})?$/.test(loc)) {
    if (!area.zipCodes.length) return "unknown";
    return area.zipCodes.includes(loc) ? "inside" : "outside";
  }
  // City: single-word place names only (avoids "my basement" false positives).
  if (/^[a-z][a-z .'-]{0,30}$/i.test(loc) && !/\s/.test(loc)) {
    if (!area.cities.length) return "unknown";
    return area.cities.some((c) => c.toLowerCase() === loc.toLowerCase()) ? "inside" : "outside";
  }
  return "unknown";
}
