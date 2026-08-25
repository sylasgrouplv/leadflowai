/**
 * PHASE 3 / CHUNK J — CONTENT REPURPOSING (`repurpose_content` WRITE tool +
 * content_pieces table + deterministic mock-content-LLM) acceptance test.
 *
 * Dogfooding item #12 ("Content repurposing: turn case studies/posts into
 * social content") — a controlled, permission-gated content capability in the
 * AI tool registry:
 *
 *   J1  registry: `repurpose_content` registered as WRITE (never HIGH_RISK),
 *       audit on, AI-accessible; WRITE tool count grows by exactly one
 *   J2  mock-LLM: DETERMINISTIC (same input → identical output), clearly
 *       labeled (isMock + mock_label + per-draft honest label), 3 platform
 *       variants by default (facebook / instagram / linkedin)
 *   J3  facts-only grounding: drafts use source sentences VERBATIM + source
 *       words only — no invented facts/stats/prices/testimonials; digits in
 *       drafts are a SUBSET of digits in the source; a digit-free source
 *       yields digit-free drafts
 *   J4  zod validation: no source → invalid_input; two sources → invalid_input
 *   J5  tenant isolation: a foreign business's content_pieces row / KB entry →
 *       tenant_mismatch, audit-logged, nothing written anywhere
 *   J6  audit log: successful call writes one agent_actions row (agent, action,
 *       input, labeled result payload)
 *   J7  no-DB-writes-by-mock: the ONLY new rows are the intended ones
 *       (content_pieces source + 3 drafts, 1 audit, 1 event, 1 notification) —
 *       leads/conversations/messages/appointments/follow-ups/KB untouched
 *   J8  KB push path: push_to_kb inserts the labeled drafts into the KB
 *   J9  event: CONTENT_REPURPOSED persisted with the created ids in the payload
 *   J10 source rows: repurposing an existing content_pieces row adds NO source
 *       duplicate (only the 3 drafts); a KB source ingests source + 3 drafts
 *   J11 no auto-publish: every created content_pieces row has status 'draft'
 *
 * Offline + deterministic: the mock-LLM performs NO network calls and NO LLM
 * calls — same input always yields the same drafts.
 *
 * Style: matches research-prospect-test.ts (in-process suite) — repo functions
 * + the tool registry, local SQLite, tenant-scoped cleanup.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run content-repurposing-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { callAiTool, TOOL_REGISTRY, AI_ACCESSIBLE_TOOLS, ToolError, type ToolContext } from "./src/server/ai/tools/registry";
import { ensureDefaultRulesForBusiness } from "./src/server/automations/rules";
import {
  generateSocialDrafts,
  splitSentences,
  REPURPOSE_PLATFORMS,
  AI_DRAFT_LABEL,
  MOCK_LLM_NAME,
  SOCIAL_DRAFT_SOURCE_TYPE,
} from "./src/server/content/repurpose";

runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();
const SOURCE = "content_repurpose_test";

async function wipeBusiness(id: string) {
  for (const lead of await db.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.businessId, id)).execute()) {
    await db.delete(s.appointments).where(eq(s.appointments.leadId, lead.id)).execute();
    await db.delete(s.followUps).where(eq(s.followUps.leadId, lead.id)).execute();
    for (const c of await db.select().from(s.conversations).where(eq(s.conversations.leadId, lead.id)).execute()) {
      await db.delete(s.messages).where(eq(s.messages.conversationId, c.id)).execute();
      await db.delete(s.conversations).where(eq(s.conversations.id, c.id)).execute();
    }
    await db.delete(s.agentActions).where(eq(s.agentActions.leadId, lead.id)).execute();
    await db.delete(s.reviews).where(eq(s.reviews.leadId, lead.id)).execute();
    await db.delete(s.leads).where(eq(s.leads.id, lead.id)).execute();
  }
  await db.delete(s.humanTasks).where(eq(s.humanTasks.businessId, id)).execute();
  await db.delete(s.events).where(eq(s.events.businessId, id)).execute();
  await db.delete(s.automationRuns).where(eq(s.automationRuns.businessId, id)).execute();
  await db.delete(s.automationRules).where(eq(s.automationRules.businessId, id)).execute();
  await db.delete(s.notifications).where(eq(s.notifications.businessId, id)).execute();
  await db.delete(s.usageEvents).where(eq(s.usageEvents.businessId, id)).execute();
  await db.delete(s.auditLogs).where(eq(s.auditLogs.businessId, id)).execute();
  await db.delete(s.widgetSettings).where(eq(s.widgetSettings.businessId, id)).execute();
  await db.delete(s.integrations).where(eq(s.integrations.businessId, id)).execute();
  await db.delete(s.subscriptions).where(eq(s.subscriptions.businessId, id)).execute();
  await db.delete(s.services).where(eq(s.services.businessId, id)).execute();
  await db.delete(s.contentPieces).where(eq(s.contentPieces.businessId, id)).execute();
  await db.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, id)).execute();
  await db.delete(s.reviewConfigs).where(eq(s.reviewConfigs.businessId, id)).execute();
  await db.delete(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, id)).execute();
  await db.delete(s.invoices).where(eq(s.invoices.businessId, id)).execute();
  await db.delete(s.businessReports).where(eq(s.businessReports.businessId, id)).execute();
  const members = await db.select({ userId: s.teamMembers.userId }).from(s.teamMembers).where(eq(s.teamMembers.businessId, id)).execute();
  await db.delete(s.teamMembers).where(eq(s.teamMembers.businessId, id)).execute();
  await db.delete(s.businesses).where(eq(s.businesses.id, id)).execute();
  for (const m of members) {
    await db.delete(s.sessions).where(eq(s.sessions.userId, m.userId)).execute();
    const stillOwned = (await db.select({ n: s.businesses.id }).from(s.businesses).where(eq(s.businesses.ownerId, m.userId)).limit(1).execute()).length > 0;
    if (stillOwned) continue;
    await db.delete(s.users).where(eq(s.users.id, m.userId)).execute();
  }
}

function resultOf(a: { resultJson: string | null }) {
  try {
    return JSON.parse(a.resultJson ?? "{}");
  } catch {
    return {};
  }
}
function count(table: any, businessId: string) {
  // `table` is a drizzle table with a businessId column (or a plain rows list).
  return db.select().from(table).where(eq((table as any).businessId, businessId)).all().length;
}
function digitsIn(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

// Source fixtures for grounding checks.
const SOURCE_WITH_FACTS = `We replaced 42 furnaces in Adrian last month. Each furnace was installed in under four hours. Call us for a free estimate today.`;
const SOURCE_FACTS_TITLE = "Furnace Replacement Case Study";
const SOURCE_NO_NUMBERS = `Our team finished a complete kitchen remodel for a family in Tecumseh. The homeowners loved the new countertops. We offer free estimates for new projects.`;
const SOURCE_NO_NUMBERS_TITLE = "Kitchen Remodel Project";

(async () => {
  const stamp = Date.now();
  const owner = await repo.createUser({ name: "Content Test Owner", email: `content-owner-${stamp}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
  const business = await repo.createBusiness({ ownerId: owner.id, name: "Content Test Co", category: "home_services" });
  const bizId = business.id;
  const ctx: ToolContext = { businessId: bizId, agent: "content" };
  // Pre-create default rules so emitEvent's lazy rule creation doesn't pollute
  // the J7 no-DB-writes delta (same baseline other suites rely on).
  await ensureDefaultRulesForBusiness(bizId);

  // =========================================================================
  console.log("\n== J1 registry — WRITE tool, permission-gated ==");
  const tool = TOOL_REGISTRY.find((t) => t.name === "repurpose_content");
  pass("J1a repurpose_content registered", !!tool, tool ? "" : "missing");
  pass("J1b permission level WRITE (never HIGH_RISK)", tool?.permissionLevel === "WRITE", `level=${tool?.permissionLevel}`);
  pass("J1c audit always on + full def", !!tool && tool.audit === true && tool.description.length > 0 && !!tool.inputSchema && typeof tool.validate === "function" && typeof tool.handler === "function", "");
  pass("J1d AI can call it (AI_ACCESSIBLE_TOOLS includes it)", AI_ACCESSIBLE_TOOLS.includes("repurpose_content"), "");
  const readTools = TOOL_REGISTRY.filter((t) => t.permissionLevel === "READ").map((t) => t.name);
  const writeTools = TOOL_REGISTRY.filter((t) => t.permissionLevel === "WRITE").map((t) => t.name);
  pass("J1e WRITE tools = previous 19 + repurpose_content + schedule_social_post (READ unchanged at 5)", writeTools.length === 21 && readTools.length === 5 && writeTools.includes("repurpose_content"), `WRITE=${writeTools.length} READ=${readTools.length}`);

  // =========================================================================
  console.log("\n== J2 mock-LLM — determinism + labeling + platforms ==");
  {
    const src = { title: SOURCE_FACTS_TITLE, body: SOURCE_WITH_FACTS };
    const a = generateSocialDrafts(src, [...REPURPOSE_PLATFORMS]);
    const b = generateSocialDrafts(src, [...REPURPOSE_PLATFORMS]);
    pass("J2a deterministic — same input → byte-identical output", JSON.stringify(a) === JSON.stringify(b), "");
    pass("J2b default platforms = facebook/instagram/linkedin (3 variants)", a.length === 3 && a.map((d) => d.platform).join(",") === "facebook,instagram,linkedin", `platforms=${a.map((d) => d.platform).join(",")}`);
    pass("J2c every draft carries the honest label", a.every((d) => d.label === AI_DRAFT_LABEL), "");
    pass("J2d every draft is non-empty and grounded (no empty bodies)", a.every((d) => d.body.trim().length > 0), "");
    pass("J2e hashtags derived from source words (all present in source)", a.every((d) => d.hashtags.every((h) => `${src.title} ${src.body}`.toLowerCase().includes(h))), `tags=${a[1].hashtags.join(",")}`);
    const partial = generateSocialDrafts(src, ["instagram"]);
    pass("J2f platform subset respected (1 platform → 1 variant)", partial.length === 1 && partial[0].platform === "instagram", "");
  }

  // =========================================================================
  console.log("\n== J3 facts-only grounding — never invent ==");
  {
    const withFacts = generateSocialDrafts({ title: SOURCE_FACTS_TITLE, body: SOURCE_WITH_FACTS }, [...REPURPOSE_PLATFORMS]);
    const srcDigits = new Set(digitsIn(`${SOURCE_FACTS_TITLE} ${SOURCE_WITH_FACTS}`));
    const draftDigits = new Set(withFacts.flatMap((d) => digitsIn(d.body)));
    pass("J3a digits in drafts ⊆ digits in source ('42' kept, none added)", [...draftDigits].every((d) => srcDigits.has(d)) && draftDigits.has("42"), `src=${[...srcDigits]} drafts=${[...draftDigits]}`);
    pass("J3b no numbers absent from source (no 99/100/24/30 invented)", withFacts.every((d) => !/(^|[^0-9])(99|100|24|30|50|75)([^0-9]|$)/.test(d.body)), "");
    const noNumbers = generateSocialDrafts({ title: SOURCE_NO_NUMBERS_TITLE, body: SOURCE_NO_NUMBERS }, [...REPURPOSE_PLATFORMS]);
    pass("J3c digit-free source → digit-free drafts", noNumbers.every((d) => digitsIn(d.body).length === 0), "");
    // Every sentence in every draft is a verbatim source sentence, the title,
    // a hashtag line, or the honest label — i.e. no new claims were generated.
    const srcSentences = new Set(splitSentences(SOURCE_WITH_FACTS));
    const grounded = withFacts.every((d) =>
      splitSentences(d.body).every((sent) => srcSentences.has(sent) || sent === SOURCE_FACTS_TITLE || sent === AI_DRAFT_LABEL || sent.startsWith("#"))
    );
    pass("J3d every draft sentence is verbatim from the source (or title/hashtags/label)", grounded, "");
    pass("J3e no invented testimonials/pricing language", withFacts.every((d) => !/testimonial|5-star|five star|rated 5/i.test(d.body)), "");
  }

  // =========================================================================
  console.log("\n== J4 zod validation failures ==");
  {
    let code = "";
    try {
      await callAiTool("repurpose_content", ctx, { title: "No source" });
    } catch (e) {
      code = e instanceof ToolError ? e.code : String(e);
    }
    pass("J4a no source at all → invalid_input", code === "invalid_input", `code=${code}`);
    const actions = await repo.listAgentActions(bizId, 300);
    const failed = actions.filter((a) => a.action === "repurpose_content" && a.success === 0).at(-1);
    const r = failed ? resultOf(failed) : {};
    pass("J4b validation failure audit-logged (success=0, invalid-input)", !!failed && r.error === "invalid-input", `result=${JSON.stringify(r)}`);

    let code2 = "";
    try {
      await callAiTool("repurpose_content", ctx, { body: "Two sources", source_piece_id: "00000000-0000-4000-8000-000000000000" });
    } catch (e) {
      code2 = e instanceof ToolError ? e.code : String(e);
    }
    pass("J4c body + source_piece_id together → invalid_input", code2 === "invalid_input", `code=${code2}`);
  }

  // =========================================================================
  console.log("\n== J5 tenant isolation (foreign content rejected) ==");
  let foreignBizId = "";
  let foreignUserId = "";
  let foreignPieceId = "";
  let foreignKbId = "";
  {
    const fUser = await repo.createUser({ name: "Foreign Content Owner", email: `content-foreign-${stamp}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
    foreignUserId = fUser.id;
    const fBiz = await repo.createBusiness({ ownerId: fUser.id, name: "Foreign Content Co", category: "home_services" });
    foreignBizId = fBiz.id;
    const fPiece = await repo.createContentPiece(foreignBizId, { sourceType: "case_study", title: "Foreign Case Study", body: "A foreign case study body with facts." });
    foreignPieceId = fPiece!.id;
    const fKb = await repo.addKnowledge(foreignBizId, { kind: "faq", question: "Foreign question", answer: "Foreign answer text." });
    foreignKbId = fKb!.id;
    const foreignPiecesBefore = count(s.contentPieces, foreignBizId);

    let code = "";
    try {
      await callAiTool("repurpose_content", ctx, { source_piece_id: foreignPieceId });
    } catch (e) {
      code = e instanceof ToolError ? e.code : String(e);
    }
    pass("J5a foreign content_pieces row → tenant_mismatch", code === "tenant_mismatch", `code=${code}`);
    let code2 = "";
    try {
      await callAiTool("repurpose_content", ctx, { source_kb_id: foreignKbId });
    } catch (e) {
      code2 = e instanceof ToolError ? e.code : String(e);
    }
    pass("J5b foreign KB entry → tenant_mismatch", code2 === "tenant_mismatch", `code=${code2}`);
    const actions = await repo.listAgentActions(bizId, 400);
    const denied = actions.filter((a) => a.action === "repurpose_content" && a.inputJson?.includes(foreignPieceId)).at(-1);
    const r = denied ? resultOf(denied) : {};
    pass("J5c tenant rejection audit-logged (success=0, rejected=true)", !!denied && denied.success === 0 && r.rejected === true, `result=${JSON.stringify(r)}`);
    // Nothing was written anywhere: foreign pieces unchanged, foreign KB unchanged, no events/notifications on either side.
    pass("J5d foreign rows untouched", count(s.contentPieces, foreignBizId) === foreignPiecesBefore && (await repo.getKnowledgeById(foreignBizId, foreignKbId)) !== null, `pieces=${count(s.contentPieces, foreignBizId)}`);
    const ourPieces = count(s.contentPieces, bizId);
    pass("J5e nothing created in our business either", ourPieces === 0, `pieces=${ourPieces}`);
  }

  // =========================================================================
  console.log("\n== J6/J7/J9/J11 — one inline call: audit + ONLY intended rows ==");
  let sourcePieceId = "";
  {
    const piecesBefore = count(s.contentPieces, bizId);
    const kbBefore = count(s.knowledgeBase, bizId);
    const actionsBefore = (await repo.listAgentActions(bizId, 500)).length;
    const eventsBefore = count(s.events, bizId);
    const notifsBefore = count(s.notifications, bizId);
    const leadsBefore = count(s.leads, bizId);

    const res = (await callAiTool(
      "repurpose_content",
      ctx,
      { title: SOURCE_FACTS_TITLE, body: SOURCE_WITH_FACTS, source_type: "case_study", source_ref: "cs-2026-08" }
    )) as Record<string, any>;

    pass("J6a call succeeds via callAiTool with labeled result", !!res && res.isMock === true && /mock/i.test(String(res.note)) && res.mock_label.includes(MOCK_LLM_NAME), `note=${String(res.note).slice(0, 40)}`);
    pass("J6b source persisted as a content_pieces row (case_study)", !!res.source_piece_id && res.source.source_type === "case_study" && res.source.source_ref === "cs-2026-08", `src=${res.source_piece_id}`);
    sourcePieceId = res.source_piece_id;
    pass("J6c exactly 3 draft variants created", Array.isArray(res.created.content_piece_ids) && res.created.content_piece_ids.length === 3 && res.variants.length === 3, `ids=${res.created.content_piece_ids?.length}`);
    pass("J6d not pushed to KB by default", res.pushed_to_kb === false && res.created.kb_ids.length === 0, "");

    const piecesAfter = count(s.contentPieces, bizId);
    const kbAfter = count(s.knowledgeBase, bizId);
    const actionsAfter = (await repo.listAgentActions(bizId, 500)).length;
    const eventsAfter = count(s.events, bizId);
    const notifsAfter = count(s.notifications, bizId);
    const leadsAfter = count(s.leads, bizId);
    pass("J7a content_pieces delta = +4 (source + 3 drafts)", piecesAfter - piecesBefore === 4, `${piecesBefore}→${piecesAfter}`);
    pass("J7b knowledge_base delta = 0 (no push)", kbAfter - kbBefore === 0, `${kbBefore}→${kbAfter}`);
    pass("J7c agent_actions delta = +1 (the tool audit only)", actionsAfter - actionsBefore === 1, `${actionsBefore}→${actionsAfter}`);
    pass("J7d events delta = +1 (CONTENT_REPURPOSED)", eventsAfter - eventsBefore === 1, `${eventsBefore}→${eventsAfter}`);
    pass("J7e notifications delta = +1 (owner bell)", notifsAfter - notifsBefore === 1, `${notifsBefore}→${notifsAfter}`);
    pass("J7f no leads created/touched", leadsAfter - leadsBefore === 0, `${leadsBefore}→${leadsAfter}`);
    const convIds = db.select({ id: s.conversations.id }).from(s.conversations).where(eq(s.conversations.businessId, bizId)).all().map((r) => r.id);
    const msgCount = convIds.length ? db.select().from(s.messages).where(inArray(s.messages.conversationId, convIds)).all().length : 0;
    pass("J7g no conversations/messages/appointments/follow-ups created", convIds.length === 0 && msgCount === 0 && count(s.appointments, bizId) === 0 && count(s.followUps, bizId) === 0, `conv=${convIds.length} msgs=${msgCount}`);

    // The persisted rows: drafts are social_draft rows chained to the source, all draft status.
    const pieces = await repo.listContentPieces(bizId, 20);
    const source = pieces.find((p) => p.id === sourcePieceId);
    const drafts = pieces.filter((p) => p.sourceType === SOCIAL_DRAFT_SOURCE_TYPE);
    pass("J11a source + every draft have status 'draft' (never auto-published)", !!source && source.status === "draft" && drafts.length === 3 && drafts.every((d) => d.status === "draft"), `statuses=${pieces.map((p) => p.status).join(",")}`);
    pass("J11b drafts chain to the source via source_ref + carry the honest label", drafts.every((d) => d.sourceRef === sourcePieceId && d.sourceType === SOCIAL_DRAFT_SOURCE_TYPE && d.body.includes(AI_DRAFT_LABEL)), "");
    pass("J11c draft titles are platform-flavored", drafts.map((d) => d.title).sort().join("|") === ["facebook draft", "instagram draft", "linkedin draft"].map((p) => `${p} — ${SOURCE_FACTS_TITLE}`).sort().join("|"), `titles=${drafts.map((d) => d.title).join(" | ")}`);

    // Audit row.
    const actions = await repo.listAgentActions(bizId, 500);
    const audit = actions.filter((a) => a.action === "repurpose_content" && a.success === 1).at(-1);
    const ar = audit ? resultOf(audit) : {};
    pass("J6e audit row: agent + input + labeled result", !!audit && audit.agent === "content" && audit.inputJson?.includes("cs-2026-08") && ar.isMock === true && ar.variants?.length === 3, `agent=${audit?.agent}`);

    // Event.
    const evRows = await db.select().from(s.events).where(and(eq(s.events.businessId, bizId), eq(s.events.type, "CONTENT_REPURPOSED"))).execute();
    pass("J9a CONTENT_REPURPOSED event persisted", evRows.length === 1, `events=${evRows.length}`);
    const ev = evRows[0];
    pass("J9b event payload carries source + created draft ids", !!ev && ev.payloadJson?.includes(sourcePieceId) && ev.payloadJson?.includes("content_piece_ids"), `payload=${ev?.payloadJson?.slice(0, 90)}`);
    const notifRows = await db.select().from(s.notifications).where(and(eq(s.notifications.businessId, bizId), eq(s.notifications.kind, "content_repurposed"))).execute();
    pass("J9c owner notification created (kind content_repurposed)", notifRows.length === 1 && /3 social drafts/.test(notifRows[0].title), `title=${notifRows[0]?.title}`);
  }

  // =========================================================================
  console.log("\n== J8 KB push path (explicit + audited) ==");
  {
    const kbBefore = count(s.knowledgeBase, bizId);
    const piecesBefore = count(s.contentPieces, bizId);
    const res = (await callAiTool(
      "repurpose_content",
      ctx,
      { title: SOURCE_NO_NUMBERS_TITLE, body: SOURCE_NO_NUMBERS, push_to_kb: true }
    )) as Record<string, any>;
    const kbAfter = count(s.knowledgeBase, bizId);
    const piecesAfter = count(s.contentPieces, bizId);
    pass("J8a push_to_kb creates 3 KB entries", res.pushed_to_kb === true && res.created.kb_ids.length === 3 && kbAfter - kbBefore === 3, `kb ${kbBefore}→${kbAfter}`);
    const kbRows = await Promise.all((res.created.kb_ids as string[]).map((id: string) => repo.getKnowledgeById(bizId, id)));
    pass("J8b KB entries carry the honest label + platform question", kbRows.every((row) => !!row && String(row.answer).includes(AI_DRAFT_LABEL) && String(row.question).includes("social draft")), "");
    pass("J8c content_pieces still source + 3 drafts per call", piecesAfter - piecesBefore === 4, `${piecesBefore}→${piecesAfter}`);
  }

  // =========================================================================
  console.log("\n== J10 source rows (piece source + KB source) ==");
  {
    // Existing content_pieces row as the source → NO source duplicate.
    const existing = await repo.createContentPiece(bizId, { sourceType: "case_study", title: "Original Case Study", body: "Our team finished a big roof replacement in five days. The customer approved the final inspection." });
    const piecesBefore = count(s.contentPieces, bizId);
    const res = (await callAiTool("repurpose_content", ctx, { source_piece_id: existing!.id, platforms: ["facebook"] })) as Record<string, any>;
    const piecesAfter = count(s.contentPieces, bizId);
    pass("J10a repurposing an existing piece adds ONLY the draft (no source duplicate)", res.source_piece_id === existing!.id && res.variants.length === 1 && piecesAfter - piecesBefore === 1, `delta=${piecesAfter - piecesBefore}`);
    // KB entry as the source → source ingested as a content_pieces row + drafts.
    const kb = await repo.addKnowledge(bizId, { kind: "faq", question: "Do you service Adrian?", answer: "Yes, we service Adrian and the surrounding area every weekday." });
    const piecesBefore2 = count(s.contentPieces, bizId);
    const res2 = (await callAiTool("repurpose_content", ctx, { source_kb_id: kb!.id })) as Record<string, any>;
    const piecesAfter2 = count(s.contentPieces, bizId);
    pass("J10b KB source ingests source row + 3 drafts (delta +4), source_type kb_entry", res2.source.source_type === "kb_entry" && res2.source.source_ref === kb!.id && piecesAfter2 - piecesBefore2 === 4, `delta=${piecesAfter2 - piecesBefore2} type=${res2.source?.source_type}`);
  }

  // =========================================================================
  // Cleanup (tenant-scoped; foreign business first — owner user shared pattern)
  // =========================================================================
  if (foreignBizId) await wipeBusiness(foreignBizId);
  await wipeBusiness(bizId);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`} — content-repurposing-test`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("content-repurposing-test crashed:", e);
  process.exit(1);
});
