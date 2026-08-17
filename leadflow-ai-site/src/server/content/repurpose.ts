/**
 * CONTENT REPURPOSING (dogfooding Phase 3 / Chunk J — automation #12).
 *
 * Turns a piece of source content (inline text, an existing content_pieces
 * row, or a knowledge_base entry) into platform-flavored social drafts —
 * Facebook / Instagram / LinkedIn — with a DETERMINISTIC, OFFLINE mock-LLM
 * splitter/summarizer (mirrors the BI narrative style in bi/report.ts: real
 * text templated into an honest narrative; no external provider, no sampling,
 * no fabricated facts).
 *
 * Hard safety rules (global AI safety rules + the chunk spec):
 *   - the drafts are grounded ONLY in the source text: sentences are used
 *     VERBATIM (hook / detail / closing), hashtags are words extracted from
 *     the source itself, and the title is the caller's or the source's — the
 *     mock never invents facts, stats, prices, testimonials, or availability,
 *   - every draft carries the honest label "AI-generated draft — review
 *     before posting",
 *   - NO auto-publishing: the tool only ever creates `content_pieces` rows
 *     with status 'draft' (publishing is a human / HIGH-RISK action), and the
 *     optional KB push inserts the drafts as plain KB entries with the same
 *     honest label (the KB has no draft flag — the label makes it explicit),
 *   - the mock is clearly labeled: the result carries isMock: true + a
 *     human-readable note so nothing can be mistaken for a real LLM writeup.
 *
 * The registry tool `repurpose_content` (WRITE, tenant-scoped, audited) calls
 * `repurposeContent()`; the tool is the ONLY app path that creates
 * content_pieces rows. On success an owner notification + a CONTENT_REPURPOSED
 * event (persisted + dispatched to the automation engine) are emitted — the
 * event surface for future rules without touching the 13-intent set.
 */
import * as repo from "../db/repo";
import { emitEvent } from "../ai/events";

export const REPURPOSE_PLATFORMS = ["facebook", "instagram", "linkedin"] as const;
export type RepurposePlatform = (typeof REPURPOSE_PLATFORMS)[number];

export const AI_DRAFT_LABEL = "AI-generated draft — review before posting";
export const MOCK_LLM_NAME = "mock-content-llm";
export const SOCIAL_DRAFT_SOURCE_TYPE = "social_draft";

// ---------------------------------------------------------------------------
// Pure mock-LLM (deterministic, offline, facts-only) — no DB, no network.
// ---------------------------------------------------------------------------

export interface RepurposeSource {
  title: string;
  body: string;
}

export interface SocialDraft {
  platform: RepurposePlatform;
  /** The post copy — grounded ONLY in the source text (verbatim sentences). */
  body: string;
  /** Hashtags derived from words present in the source text (never invented). */
  hashtags: string[];
  /** Honest label — every draft must carry it (never auto-published). */
  label: string;
}

/** Common words never promoted to hashtags (junk otherwise). */
const HASHTAG_STOPLIST = new Set([
  "about", "after", "again", "also", "been", "before", "being", "could", "every", "from", "have", "here", "into",
  "just", "like", "more", "most", "much", "need", "only", "other", "over", "really", "some", "such", "than",
  "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "very", "were", "when",
  "where", "which", "while", "will", "with", "would", "your", "youre", "our", "ours", "weve", "well", "today",
  "thank", "thanks", "please", "always", "never", "great", "good", "best", "everyone", "everything", "anything",
  "something", "nothing", "little", "still", "even", "back", "around", "because", "during", "before", "first",
  "finally", "looking", "getting", "going", "make", "made", "keep", "know", "think", "want", "come", "came",
]);

/**
 * Deterministic sentence splitter (no lookbehind — stable across engines).
 * Newlines are sentence boundaries too (a title line is its own sentence).
 * Returns trimmed non-empty sentences in order.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?\n]+[.!?]+["']?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  const rest = text.replace(re, "").trim();
  if (rest) out.push(rest);
  return out.length ? out : [];
}

/** Deterministic hashtag candidates: words from the source, length ≥ 5, deduped. */
export function extractKeywords(text: string, max = 4): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const raw of words) {
    const w = raw.replace(/^[0-9]+/, ""); // a tag that is only digits is useless
    if (w.length < 5 || HASHTAG_STOPLIST.has(w)) continue;
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

function hashtagLine(keywords: string[]): string {
  return keywords.length ? keywords.map((k) => `#${k}`).join(" ") : "";
}

/**
 * The deterministic mock-LLM splitter/summarizer. Given a source, produce one
 * draft per requested platform. Sentences are used verbatim — the generator
 * NEVER adds numbers, prices, testimonials, availability, or any claim that is
 * not present in the source text. Same input → byte-identical output.
 */
export function generateSocialDrafts(source: RepurposeSource, platforms: RepurposePlatform[]): SocialDraft[] {
  const title = source.title.trim();
  const sentences = splitSentences(source.body);
  const hook = sentences[0] ?? "";
  const detail = sentences[1] ?? hook;
  const closing = sentences[sentences.length - 1] ?? "";
  const keywords = extractKeywords(`${source.title} ${source.body}`);

  const drafts: SocialDraft[] = [];
  for (const platform of platforms) {
    let body = "";
    if (platform === "facebook") {
      // Storytelling shape: title + the first (hook) and second (detail)
      // sentences verbatim, then the closing line.
      body = [title, hook, detail, closing].filter(Boolean).join("\n\n");
    } else if (platform === "instagram") {
      // Short + visual-first: hook and closing only, hashtags appended.
      body = [hook, closing].filter(Boolean).join("\n\n");
      const tags = hashtagLine(keywords);
      if (tags) body = `${body}\n\n${tags}`;
    } else {
      // Professional: title + hook + detail on one paragraph, closing below.
      body = [title, [hook, detail].filter(Boolean).join(" "), closing].filter(Boolean).join("\n\n");
    }
    if (!body) body = title; // degenerate source — never empty
    drafts.push({ platform, body, hashtags: [...keywords], label: AI_DRAFT_LABEL });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Orchestration (called by the repurpose_content registry tool)
// ---------------------------------------------------------------------------

export interface RepurposeInput {
  title?: string;
  body?: string;
  source_piece_id?: string;
  source_kb_id?: string;
  source_type?: string;
  source_ref?: string;
  push_to_kb?: boolean;
  platforms?: RepurposePlatform[];
}

export interface RepurposeResult {
  source_piece_id: string | null;
  source: { title: string; source_type: string; source_ref: string; body_length: number };
  isMock: true;
  mock_label: string;
  variants: SocialDraft[];
  created: { content_piece_ids: string[]; kb_ids: string[] };
  pushed_to_kb: boolean;
  note: string;
}

/**
 * Resolve the source content (inline body, existing content_pieces row, or KB
 * entry), generate the platform drafts, persist the source (when it wasn't a
 * content_pieces row already) + one draft row per platform (status 'draft'),
 * optionally push the drafts to the knowledge base as labeled entries, notify
 * the owner, and emit CONTENT_REPURPOSED. Tenant-scoped: the caller (registry
 * validate) guarantees piece/kb ids belong to `businessId`; we re-check anyway.
 */
export async function repurposeContent(businessId: string, input: RepurposeInput): Promise<RepurposeResult> {
  const platforms = (input.platforms && input.platforms.length ? input.platforms : [...REPURPOSE_PLATFORMS]) as RepurposePlatform[];

  // --- Resolve + persist the source ---------------------------------------
  let sourceTitle = (input.title ?? "").trim();
  let sourceBody = (input.body ?? "").trim();
  let sourceType = input.source_type ?? "post";
  let sourceRef = input.source_ref ?? "";
  let sourcePieceId: string | null = null;

  if (input.source_piece_id) {
    const piece = await repo.getContentPieceById(businessId, input.source_piece_id);
    if (!piece) throw new Error(`content piece ${input.source_piece_id} not found in business ${businessId}`);
    sourcePieceId = piece.id;
    sourceTitle = sourceTitle || piece.title;
    sourceBody = piece.body;
    sourceType = piece.sourceType;
    sourceRef = piece.sourceRef;
  } else if (input.source_kb_id) {
    const kb = await repo.getKnowledgeById(businessId, input.source_kb_id);
    if (!kb) throw new Error(`knowledge entry ${input.source_kb_id} not found in business ${businessId}`);
    sourceTitle = sourceTitle || (kb.question && kb.question.trim() ? kb.question : "Knowledge base entry");
    sourceBody = kb.answer;
    sourceType = input.source_type ?? "kb_entry";
    sourceRef = input.source_ref ?? kb.id;
  }

  // Inline text (or a KB source) becomes the source content_pieces row — the
  // table is the in-product home for original content.
  if (!sourcePieceId) {
    const piece = await repo.createContentPiece(businessId, {
      sourceType,
      sourceRef,
      title: sourceTitle || "Untitled content",
      body: sourceBody,
      status: "draft",
    });
    if (!piece) throw new Error("content piece not created");
    sourcePieceId = piece.id;
    sourceTitle = piece.title;
    sourceType = piece.sourceType;
    sourceRef = piece.sourceRef;
  }

  // --- Generate + persist the drafts (never auto-published) ----------------
  const drafts = generateSocialDrafts({ title: sourceTitle, body: sourceBody }, platforms);
  const contentPieceIds: string[] = [];
  const kbIds: string[] = [];
  for (const draft of drafts) {
    const full = `${draft.body}\n\n${draft.label}`;
    const row = await repo.createContentPiece(businessId, {
      sourceType: SOCIAL_DRAFT_SOURCE_TYPE,
      sourceRef: sourcePieceId,
      title: `${draft.platform} draft — ${sourceTitle}`,
      body: full,
      status: "draft",
    });
    if (row) contentPieceIds.push(row.id);
    if (input.push_to_kb) {
      const kb = await repo.addKnowledge(businessId, {
        kind: "general",
        question: `${draft.platform} social draft — ${sourceTitle}`,
        answer: full,
      });
      if (kb) kbIds.push(kb.id);
    }
  }

  // --- Owner notification + event (observability / future automation rules) -
  await repo.createNotification(businessId, {
    kind: "content_repurposed",
    title: `Content repurposed — ${drafts.length} social draft${drafts.length === 1 ? "" : "s"} ready for review`,
    body: `${sourceTitle} · ${platforms.join(", ")} · ${AI_DRAFT_LABEL}`,
  });
  await emitEvent({
    type: "CONTENT_REPURPOSED",
    businessId,
    payload: {
      source_piece_id: sourcePieceId,
      content_piece_ids: contentPieceIds,
      platforms,
      pushed_to_kb: !!input.push_to_kb,
      title: sourceTitle,
    },
  });

  return {
    source_piece_id: sourcePieceId,
    source: { title: sourceTitle, source_type: sourceType, source_ref: sourceRef, body_length: sourceBody.length },
    isMock: true,
    mock_label: `Drafts generated by ${MOCK_LLM_NAME} — deterministic offline mock (no external LLM).`,
    variants: drafts,
    created: { content_piece_ids: contentPieceIds, kb_ids: kbIds },
    pushed_to_kb: !!input.push_to_kb,
    note: `MOCK LLM — sample drafts generated offline from the source text only (provider: ${MOCK_LLM_NAME}). Nothing is auto-published; every draft must be reviewed and published by a human.`,
  };
}
