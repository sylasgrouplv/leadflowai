/**
 * WebFetchProvider — Mock implementation (dogfooding Phase 3 / Chunk I —
 * "Prospect research: automated enrichment of prospect data").
 *
 * Mirrors the MockAiProvider pattern (owner decision 2026-08-11: mock until
 * real credentials; the swap is config-only via WEBFETCH_PROVIDER env):
 *   - deterministic — the same name/domain always returns the same record,
 *   - OFFLINE — performs NO real network calls, ever (tests and default
 *     runtime never touch the web),
 *   - clearly labeled — every record carries isMock: true and a human-readable
 *     note, so an agent can never mistake sample enrichment for real research,
 *   - safety-shaped — facts only (website, phone, service keywords, review
 *     snippets); NEVER pricing, NEVER availability, no unverifiable claims
 *     (spec §3 global AI safety rules),
 *   - sample phones use the fictional 555-01xx range and sample websites use
 *     the reserved .example.test TLD so nothing in the mock can collide with a
 *     real business.
 *
 * A real implementation (live fetch / search API) swaps in later by writing a
 * class behind WebFetchProvider (types.ts) and adding it to the factory in
 * ./index.ts — no app code touched.
 */
import type { WebFetchInput, WebFetchProvider, WebFetchResult, WebReviewSnippet } from "./types";

export const MOCK_WEB_FETCH_NAME = "mock-web-fetch";

/** Sample websites always use the reserved .example.test TLD — never real. */
const SAMPLE_TLD = ".example.test";

/** The fictional 555-01xx exchange is reserved for sample/dramatic use. */
function samplePhone(area: string, n: string): string {
  return `(${area}) 555-01${n}`;
}

export interface MockFixture {
  category: string;
  websiteHost: string;
  areaCode: string;
  /** Deterministic service keywords for the trade. */
  serviceKeywords: string[];
  /** Labeled sample review snippets (never passed off as real reviews). */
  reviewSnippets: WebReviewSnippet[];
}

/** Curated fixture-style sample records per trade (detected from name/domain). */
const FIXTURES: Record<string, MockFixture> = {
  hvac: {
    category: "HVAC",
    websiteHost: "smithheating.example.test",
    areaCode: "517",
    serviceKeywords: ["AC repair", "furnace installation", "duct cleaning", "thermostat replacement", "heating maintenance"],
    reviewSnippets: [
      { source: "SampleReviewSite", text: "Sample review: quick to respond and the technician explained everything.", rating: 4.5 },
      { source: "SampleReviewSite", text: "Sample review: showed up on time for the tune-up.", rating: 4.0 },
    ],
  },
  plumbing: {
    category: "Plumbing",
    websiteHost: "exampleplumbing.example.test",
    areaCode: "517",
    serviceKeywords: ["drain cleaning", "water heater repair", "leak detection", "pipe repair", "bathroom remodeling"],
    reviewSnippets: [
      { source: "SampleReviewSite", text: "Sample review: fixed a burst pipe quickly and cleaned up after.", rating: 5.0 },
      { source: "SampleReviewSite", text: "Sample review: fair price for the water heater work.", rating: 4.5 },
    ],
  },
  roofing: {
    category: "Roofing",
    websiteHost: "exampleroofing.example.test",
    areaCode: "517",
    serviceKeywords: ["roof repair", "roof replacement", "storm damage", "gutter installation", "siding"],
    reviewSnippets: [
      { source: "SampleReviewSite", text: "Sample review: new roof looks great and the crew was tidy.", rating: 4.5 },
      { source: "SampleReviewSite", text: "Sample review: handled the insurance paperwork with us.", rating: 4.0 },
    ],
  },
  landscaping: {
    category: "Landscaping",
    websiteHost: "examplelandscape.example.test",
    areaCode: "517",
    serviceKeywords: ["lawn care", "landscape design", "snow removal", "mulching", "tree trimming"],
    reviewSnippets: [
      { source: "SampleReviewSite", text: "Sample review: lawn looks great every week.", rating: 4.5 },
      { source: "SampleReviewSite", text: "Sample review: reliable crew, showed up on schedule.", rating: 4.0 },
    ],
  },
  cleaning: {
    category: "Cleaning",
    websiteHost: "examplecleaning.example.test",
    areaCode: "517",
    serviceKeywords: ["residential cleaning", "office cleaning", "move-out cleaning", "deep cleaning", "window cleaning"],
    reviewSnippets: [
      { source: "SampleReviewSite", text: "Sample review: spotless after the deep clean.", rating: 5.0 },
      { source: "SampleReviewSite", text: "Sample review: thorough and polite team.", rating: 4.5 },
    ],
  },
  auto: {
    category: "Auto repair",
    websiteHost: "exampleauto.example.test",
    areaCode: "517",
    serviceKeywords: ["oil change", "brake repair", "engine diagnostics", "tire service", "state inspection"],
    reviewSnippets: [
      { source: "SampleReviewSite", text: "Sample review: honest about what needed fixing.", rating: 4.5 },
      { source: "SampleReviewSite", text: "Sample review: quick oil change, fair price.", rating: 4.0 },
    ],
  },
  restoration: {
    category: "Restoration",
    websiteHost: "examplere.store.example.test",
    areaCode: "517",
    serviceKeywords: ["water damage restoration", "fire damage repair", "mold remediation", "flood cleanup", "emergency response"],
    reviewSnippets: [
      { source: "SampleReviewSite", text: "Sample review: responded fast after the water leak.", rating: 5.0 },
      { source: "SampleReviewSite", text: "Sample review: helped us through the whole restoration.", rating: 4.5 },
    ],
  },
  default: {
    category: "Local service business",
    websiteHost: "examplebusiness.example.test",
    areaCode: "517",
    serviceKeywords: ["residential services", "commercial services", "free estimates", "scheduled appointments", "emergency calls"],
    reviewSnippets: [
      { source: "SampleReviewSite", text: "Sample review: professional from start to finish.", rating: 4.5 },
      { source: "SampleReviewSite", text: "Sample review: responsive and easy to work with.", rating: 4.0 },
    ],
  },
};

/** Trade keywords used to detect a category from the provided name/domain. */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  hvac: ["hvac", "heating", "cooling", "ac repair", "air conditioning", "furnace", "smithhvac", "aircond", "climate", "temperature control"],
  plumbing: ["plumb", "pipe", "water heater", "drain", "sewer", "leak", "faucet"],
  roofing: ["roof", "shingle", "siding", "gutter", "storm"],
  landscaping: ["landscap", "lawn", "snow", "mulch", "tree", "yard", "grounds"],
  cleaning: ["clean", "maid", "janitor", "housekeep"],
  auto: ["auto", "automotive", "car repair", "tire", "oil change", "brake", "mechanic", "garage"],
  restoration: ["restor", "water damage", "fire damage", "mold", "flood", "disaster"],
};

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .split("?")[0]
    .trim();
}

/** Deterministic slug for a business name (used only for sample .example.test hosts). */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "business";
}

function detectCategory(name: string | undefined, domain: string | undefined): string {
  const haystack = `${name ?? ""} ${domain ?? ""}`.toLowerCase();
  let best = "default";
  let bestHits = 0;
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    let hits = 0;
    for (const w of words) if (haystack.includes(w)) hits += 1;
    if (hits > bestHits) {
      best = cat;
      bestHits = hits;
    }
  }
  return best;
}

/**
 * MockWebFetchProvider — deterministic, offline, clearly-labeled sample
 * enrichment. Never performs real network calls; every result is labeled mock.
 */
export class MockWebFetchProvider implements WebFetchProvider {
  readonly name = MOCK_WEB_FETCH_NAME;

  async fetch(input: WebFetchInput): Promise<WebFetchResult> {
    const name = input.name?.trim() || "";
    const rawDomain = input.domain?.trim() || "";
    const resolvedDomain = rawDomain ? normalizeDomain(rawDomain) : null;
    const category = detectCategory(name, rawDomain);
    const fixture = FIXTURES[category] ?? FIXTURES.default;
    const fetchedAt = Date.now();

    // A provided domain resolves to its real-looking-but-normalized form; when
    // no domain was given the mock derives a clearly-fake sample host on the
    // reserved .example.test TLD (never a real business's site).
    const website = resolvedDomain
      ? `https://${resolvedDomain}`
      : `https://${slugify(name || "business")}${SAMPLE_TLD}`;

    return {
      provider: this.name,
      isMock: true,
      resolvedDomain: resolvedDomain ?? `${slugify(name || "business")}${SAMPLE_TLD}`,
      website,
      phone: samplePhone(fixture.areaCode, String(Math.abs(hashCode(name + "|" + (resolvedDomain ?? ""))) % 90 + 10).padStart(2, "0")),
      serviceKeywords: [...fixture.serviceKeywords],
      reviewSnippets: fixture.reviewSnippets.map((s) => ({ ...s })),
      note: `MOCK DATA — sample enrichment record for development/testing (provider: ${this.name}). NOT fetched from the web. Do not use as real business facts.`,
      disclaimer:
        "Research is facts-only enrichment. No pricing, no availability, and no unverifiable claims are included; treat all fields as labeled samples until a real WebFetchProvider is configured.",
      fetchedAt,
    };
  }
}

/** Deterministic small string hash (stable across runs/processes). */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
