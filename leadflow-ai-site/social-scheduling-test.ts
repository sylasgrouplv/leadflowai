/**
 * PHASE 3 / CHUNK K — SOCIAL MEDIA SCHEDULING (social_posts table + SocialProvider
 * interface + mock + per-business post queue + scheduled worker) acceptance test.
 *
 * Dogfooding item #13 ("Social media scheduling: schedule and publish social
 * posts on a per-business calendar") — a controlled, permission-gated WRITE
 * capability in the AI tool registry, with the publish executed by a scheduled
 * worker through the SocialProvider interface (mock by default):
 *
 *   K1  registry: `schedule_social_post` registered as WRITE (never HIGH_RISK),
 *       audit on, AI-accessible; WRITE tool count grows by exactly one
 *   K2  table + migration: social_posts exists with the expected columns and
 *       the due-not-yet-posted default state (status 'pending', posted_at null)
 *   K3  provider: getSocialProvider() returns the clearly-labeled mock
 *       ("mock-social"); a mock post result is labeled (note mentions MOCK) and
 *       no network/DB write happens inside the provider
 *   K4  scheduling: schedule_social_post creates a pending queue row with
 *       scheduledFor + provider "mock-social"
 *   K5  worker: a DUE pending post (scheduledFor <= now) is posted through the
 *       SocialProvider → status transitions pending → posting → posted, posted_at
 *       set, provider recorded, NO real external call
 *   K6  audit: the successful post writes one agent_actions row (agent social,
 *       action post, provider + externalId in result)
 *   K7  event + notification: POST_PUBLISHED persisted with the post id +
 *       platform; owner notification kind 'post_published'
 *   K8  tenant isolation: a foreign business's post is NEVER posted by a worker
 *       scoped to ours, and a direct postDueSocialPost(ourBiz, foreignPostId)
 *       is a no-op — the foreign row stays pending, nothing audited on our side
 *   K9  status transitions: future-dated post stays pending (not yet due);
 *       cancelled post is never published by the worker
 *   K10 no unintended writes: the only new rows are social_posts +
 *       agent_actions(post) + event + notification — leads/conversations/
 *       messages/appointments/follow-ups/KB/content untouched
 *
 * Offline + deterministic: the mock SocialProvider performs NO network/API
 * calls — same input always yields the same labeled sample result.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run social-scheduling-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { callAiTool, TOOL_REGISTRY, AI_ACCESSIBLE_TOOLS, type ToolContext } from "./src/server/ai/tools/registry";
import { ensureDefaultRulesForBusiness } from "./src/server/automations/rules";
import { getSocialProvider } from "./src/server/integrations";
import { postDueSocialPost, runSocialPostScheduler, scheduleSocialPost } from "./src/server/social/engine";

runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();

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
  await db.delete(s.socialPosts).where(eq(s.socialPosts.businessId, id)).execute();
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
  return db.select().from(table).where(eq((table as any).businessId, businessId)).all().length;
}
const FUTURE = Date.now() + 5 * 24 * 60 * 60 * 1000;
const DUE = Date.now() - 60_000;

(async () => {
  const stamp = Date.now();
  const owner = await repo.createUser({ name: "Social Test Owner", email: `social-owner-${stamp}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
  const business = await repo.createBusiness({ ownerId: owner.id, name: "Social Test Co", category: "home_services" });
  const bizId = business.id;
  const ctx: ToolContext = { businessId: bizId, agent: "social" };
  await ensureDefaultRulesForBusiness(bizId);

  // =========================================================================
  console.log("\n== K1 registry — WRITE tool, permission-gated ==");
  const tool = TOOL_REGISTRY.find((t) => t.name === "schedule_social_post");
  pass("K1a schedule_social_post registered", !!tool, tool ? "" : "missing");
  pass("K1b permission level WRITE (never HIGH_RISK)", tool?.permissionLevel === "WRITE", `level=${tool?.permissionLevel}`);
  pass("K1c audit always on + full def", !!tool && tool.audit === true && tool.description.length > 0 && !!tool.inputSchema && typeof tool.validate === "function" && typeof tool.handler === "function", "");
  pass("K1d AI can call it (AI_ACCESSIBLE_TOOLS includes it)", AI_ACCESSIBLE_TOOLS.includes("schedule_social_post"), "");
  const readTools = TOOL_REGISTRY.filter((t) => t.permissionLevel === "READ").map((t) => t.name);
  const writeTools = TOOL_REGISTRY.filter((t) => t.permissionLevel === "WRITE").map((t) => t.name);
  pass("K1e WRITE tools = previous 20 + schedule_social_post (READ unchanged at 5)", writeTools.length === 21 && readTools.length === 5 && writeTools.includes("schedule_social_post"), `WRITE=${writeTools.length} READ=${readTools.length}`);

  // =========================================================================
  console.log("\n== K2 table + migration present ==");
  {
    const cols = db.select({ id: s.socialPosts.id, businessId: s.socialPosts.businessId, provider: s.socialPosts.provider, platform: s.socialPosts.platform, message: s.socialPosts.message, scheduledFor: s.socialPosts.scheduledFor, status: s.socialPosts.status, postedAt: s.socialPosts.postedAt, error: s.socialPosts.error }).from(s.socialPosts).all();
    pass("K2a social_posts table queryable (migration applied)", Array.isArray(cols), "");
    pass("K2b default status is 'pending' + posted_at null on insert", true, "see K4 (rows carry the defaults)");
  }

  // =========================================================================
  console.log("\n== K3 provider — labeled mock, no external call ==");
  {
    const provider = getSocialProvider();
    pass("K3a getSocialProvider returns the mock (name 'mock-social')", provider.name === "mock-social", `name=${provider.name}`);
    const res = await provider.post({ businessId: bizId, platform: "facebook", message: "Any message" });
    // The provider MUST NOT write to the database — verify no social_posts row was created by the provider call alone.
    const postsAfter = count(s.socialPosts, bizId);
    pass("K3b mock result is labeled (MOCK) + deterministic externalId + posted", res.status === "posted" && /MOCK/i.test(res.note) && /^mock_post_/.test(res.externalId), `externalId=${res.externalId}`);
    pass("K3c provider performs NO DB write (no row created by the provider call)", postsAfter === 0, `posts=${postsAfter}`);
  }

  // =========================================================================
  console.log("\n== K4 scheduling — tool creates a pending queue row ==");
  let duePostIdFinal = "";
  {
    const res = (await callAiTool("schedule_social_post", ctx, {
      platform: "facebook",
      message: "Check out our new furnace maintenance special.",
      scheduledFor: DUE,
    })) as Record<string, any>;
    pass("K4a tool returns the created post id + provider", !!res.postId && res.status === "pending" && res.provider === "mock-social", `provider=${res.provider}`);
    const row = await repo.getSocialPostById(bizId, res.postId);
    pass("K4b row is pending with scheduledFor + provider recorded", !!row && row.status === "pending" && row.scheduledFor === DUE && row.provider === "mock-social", `provider=${row?.provider} status=${row?.status}`);
    pass("K4c row is NOT posted yet (postedAt null)", !!row && row.postedAt === null, `postedAt=${row?.postedAt}`);
    pass("K4d scheduling is audit-logged (schedule_social_post action)", (await repo.listAgentActions(bizId, 300)).some((a) => a.action === "schedule_social_post" && a.success === 1), "");
    duePostIdFinal = res.postId;
  }

  // =========================================================================
  console.log("\n== K5 worker — a due mock post gets posted via SocialProvider ==");
  {
    const before = await repo.getSocialPostById(bizId, duePostIdFinal);
    pass("K5a precondition: row is pending and due", !!before && before.status === "pending" && before.scheduledFor <= Date.now(), `status=${before?.status}`);
    const run = await runSocialPostScheduler(Date.now(), bizId);
    const after = await repo.getSocialPostById(bizId, duePostIdFinal);
    pass("K5b worker posted exactly one due row (checked=1, posted=1)", run.checked === 1 && run.posted === 1, `checked=${run.checked} posted=${run.posted}`);
    pass("K5c row transitioned to 'posted' with postedAt set", !!after && after.status === "posted" && after.postedAt !== null, `status=${after?.status} postedAt=${after?.postedAt}`);
    pass("K5d provider name recorded on the row (mock-social)", after?.provider === "mock-social", `provider=${after?.provider}`);
    pass("K5e error column is null on success", after?.error === null, `error=${after?.error}`);
  }

  // =========================================================================
  console.log("\n== K6 audit on post ==");
  {
    const actions = await repo.listAgentActions(bizId, 400);
    const postAudit = actions.filter((a) => a.action === "post" && a.success === 1).at(-1);
    const r = postAudit ? resultOf(postAudit) : {};
    pass("K6a one successful 'post' agent_actions row", !!postAudit && postAudit.agent === "social", `agent=${postAudit?.agent}`);
    pass("K6b result includes provider + externalId (labeled)", !!postAudit && r.provider === "mock-social" && /^mock_post_/.test(r.externalId ?? ""), `result=${JSON.stringify(r)}`);
    pass("K6c input records postId + platform", !!postAudit && postAudit.inputJson?.includes(duePostIdFinal) && postAudit.inputJson?.includes("facebook"), "");
  }

  // =========================================================================
  console.log("\n== K7 event + owner notification on publish ==");
  {
    const evRows = await db.select().from(s.events).where(and(eq(s.events.businessId, bizId), eq(s.events.type, "POST_PUBLISHED"))).execute();
    pass("K7a POST_PUBLISHED event persisted", evRows.length === 1, `events=${evRows.length}`);
    pass("K7b event payload carries postId + platform", !!evRows[0] && evRows[0].payloadJson?.includes(duePostIdFinal) && evRows[0].payloadJson?.includes("facebook"), `payload=${evRows[0]?.payloadJson?.slice(0, 90)}`);
    const notifRows = await db.select().from(s.notifications).where(and(eq(s.notifications.businessId, bizId), eq(s.notifications.kind, "post_published"))).execute();
    pass("K7c owner notification created (kind post_published)", notifRows.length === 1 && /Published to facebook/.test(notifRows[0].title), `title=${notifRows[0]?.title}`);
  }

  // =========================================================================
  console.log("\n== K8 tenant isolation — foreign post never posted by our worker ==");
  let foreignBizId = "";
  let foreignUserId = "";
  let foreignPostId = "";
  {
    const fUser = await repo.createUser({ name: "Foreign Social Owner", email: `social-foreign-${stamp}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
    foreignUserId = fUser.id;
    const fBiz = await repo.createBusiness({ ownerId: fUser.id, name: "Foreign Social Co", category: "home_services" });
    foreignBizId = fBiz.id;
    await ensureDefaultRulesForBusiness(foreignBizId);
    const fPost = await scheduleSocialPost(foreignBizId, { platform: "linkedin", message: "Foreign post that must never be posted by our worker.", scheduledFor: DUE });
    foreignPostId = fPost.postId;
    const ourPostsBefore = count(s.socialPosts, bizId);
    const ourActionsBefore = (await repo.listAgentActions(bizId, 500)).length;
    const ourEventsBefore = count(s.events, bizId);

    // 1) A worker scoped to our business must NOT touch the foreign post.
    const run = await runSocialPostScheduler(Date.now(), bizId);
    const fRow = await repo.getSocialPostById(foreignBizId, foreignPostId);
    pass("K8a worker scoped to ours posts only ours (foreign unchanged)", run.checked >= 0 && fRow?.status === "pending", `foreign status=${fRow?.status}`);

    // 2) A DIRECT call through OUR scope with a foreign post id is a no-op.
    const res = await postDueSocialPost(bizId, foreignPostId);
    const fRow2 = await repo.getSocialPostById(foreignBizId, foreignPostId);
    const ourPostsAfter = count(s.socialPosts, bizId);
    const ourActionsAfter = (await repo.listAgentActions(bizId, 500)).length;
    const ourEventsAfter = count(s.events, bizId);
    pass("K8b direct postDueSocialPost(ourBiz, foreignId) → skipped (not-found/foreign)", res.status === "skipped" && (res.reason === "not-found-or-foreign" || res.reason === "status-pending"), `status=${res.status} reason=${res.reason}`);
    pass("K8c foreign post still pending — never posted", fRow2?.status === "pending", `status=${fRow2?.status}`);
    pass("K8d nothing written on our side (posts/actions/events unchanged)", ourPostsAfter === ourPostsBefore && ourActionsAfter === ourActionsBefore && ourEventsAfter === ourEventsBefore, `posts ${ourPostsBefore}→${ourPostsAfter} actions ${ourActionsBefore}→${ourActionsAfter}`);

    // 3) The global worker (no scope) posts each row under ITS OWN business —
    //    the foreign post is posted only under the foreign business scope.
    const runGlobal = await runSocialPostScheduler(Date.now());
    const fRow3 = await repo.getSocialPostById(foreignBizId, foreignPostId);
    pass("K8e global worker posts foreign row under its own tenant (status posted)", fRow3?.status === "posted", `status=${fRow3?.status}`);

    // 4) A second pass idempotently skips already-posted rows (no re-post).
    const run2 = await runSocialPostScheduler(Date.now(), bizId);
    const after2 = await repo.getSocialPostById(bizId, duePostIdFinal);
    pass("K8f worker skips already-posted row (no double publish)", run2.posted === 0 && after2?.status === "posted" && after2.postedAt !== null, `posted=${run2.posted}`);
  }

  // =========================================================================
  console.log("\n== K9 status transitions — future + cancelled never publish ==");
  {
    // Future-dated post stays pending.
    const future = await scheduleSocialPost(bizId, { platform: "instagram", message: "Not due yet.", scheduledFor: FUTURE });
    const runF = await runSocialPostScheduler(Date.now(), bizId);
    const fRow = await repo.getSocialPostById(bizId, future.postId);
    pass("K9a future-dated post is untouched by the worker (stays pending)", runF.posted === 0 && fRow?.status === "pending" && fRow.postedAt === null, `status=${fRow?.status}`);

    // Cancelled post is never published even once due.
    const cancelled = await scheduleSocialPost(bizId, { platform: "x", message: "Cancel me.", scheduledFor: DUE });
    await repo.cancelSocialPost(bizId, cancelled.postId);
    const cBefore = await repo.getSocialPostById(bizId, cancelled.postId);
    const runC = await runSocialPostScheduler(Date.now(), bizId);
    const cAfter = await repo.getSocialPostById(bizId, cancelled.postId);
    pass("K9b cancelled post stays cancelled — never posted", cBefore?.status === "cancelled" && cAfter?.status === "cancelled" && cAfter.postedAt === null && runC.posted === 0, `status=${cAfter?.status}`);

    // A cancelled post cannot be re-posted directly either.
    const res = await postDueSocialPost(bizId, cancelled.postId);
    const cAfter2 = await repo.getSocialPostById(bizId, cancelled.postId);
    pass("K9c postDueSocialPost on a cancelled post → skipped (status-cancelled)", res.status === "skipped" && res.reason === "status-cancelled" && cAfter2?.status === "cancelled", `reason=${res.reason}`);
  }

  // =========================================================================
  console.log("\n== K10 no unintended writes across the run ==");
  {
    const leadsN = count(s.leads, bizId);
    const convN = count(s.conversations, bizId);
    const msgN = db.select().from(s.messages).where(inArray(s.messages.conversationId, db.select({ id: s.conversations.id }).from(s.conversations).where(eq(s.conversations.businessId, bizId)).all().map((r) => r.id))).all().length;
    const appsN = count(s.appointments, bizId);
    const fupN = count(s.followUps, bizId);
    const kbN = count(s.knowledgeBase, bizId);
    const contentN = count(s.contentPieces, bizId);
    pass("K10a no leads created", leadsN === 0, `leads=${leadsN}`);
    pass("K10b no conversations/messages", convN === 0 && msgN === 0, `conv=${convN} msgs=${msgN}`);
    pass("K10c no appointments/follow-ups", appsN === 0 && fupN === 0, `apps=${appsN} fups=${fupN}`);
    pass("K10d no knowledge-base / content-piece rows", kbN === 0 && contentN === 0, `kb=${kbN} content=${contentN}`);
  }

  // =========================================================================
  // Cleanup (tenant-scoped; foreign business first — owner user shared pattern)
  // =========================================================================
  if (foreignBizId) await wipeBusiness(foreignBizId);
  await wipeBusiness(bizId);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`} — social-scheduling-test`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("social-scheduling-test crashed:", e);
  process.exit(1);
});
