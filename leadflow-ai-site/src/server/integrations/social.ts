/**
 * SocialProvider — Mock implementation (dogfooding Phase 3 / Chunk K —
 * "Social media scheduling", #13).
 *
 * Mirrors the MockWebFetchProvider / MockSmsProvider pattern: the posting
 * engine (src/server/social/engine.ts) calls getSocialProvider() and the mock
 * is the default until real credentials exist. Swapping in a real provider is
 * a new class behind the same SocialProvider interface (types.ts) + a
 * SOCIAL_PROVIDER env change — no app code touched.
 *
 *   - deterministic — same input → the same sample external id,
 *   - OFFLINE — performs NO real network / API calls, ever,
 *   - clearly labeled — name "mock-social" and every result carries a
 *     human-readable note, so a posted row can never be mistaken for a real
 *     network post (the engine also records the provider name on the row),
 *   - MUST NOT write to the database — persistence / audit / tenant-scoping /
 *     events are the engine's job; here we only return a sample result.
 */
import type { SocialPostInput, SocialProvider, SocialPostResult } from "./types";

export const MOCK_SOCIAL_NAME = "mock-social";

/** Deterministic small string hash (stable across runs/processes). */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export class MockSocialProvider implements SocialProvider {
  readonly name = MOCK_SOCIAL_NAME;

  async post(input: SocialPostInput): Promise<SocialPostResult> {
    // The mock never touches the network or the DB. Deterministic external id
    // so tests (and any caller) can assert a stable, labeled sample result.
    const seed = `${input.businessId}|${input.platform}|${input.message}`;
    const externalId = `mock_post_${hashCode(seed).toString(16)}`;
    return {
      externalId,
      status: "posted",
      postedAt: Date.now(),
      note: `MOCK POST — sample publish record for development/testing (provider: ${this.name}). NOT actually posted to ${input.platform}. Swap in a real SocialProvider (SOCIAL_PROVIDER env) to publish for real.`,
    };
  }
}
