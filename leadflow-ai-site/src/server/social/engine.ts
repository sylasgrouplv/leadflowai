/**
 * SOCIAL MEDIA SCHEDULING — the posting engine (dogfooding Phase 3 /
 * Chunk K — "Social media scheduling", #13).
 *
 * Model (closest pattern: followups/engine.ts + the BI weekly-job): a
 * `social_posts` row per scheduled post, and a scheduled worker that picks due
 * rows and publishes them. Rows are created ONLY through the `schedule_social_post`
 * WRITE tool (audited, tenant-scoped) or the in-app social route
 * (src/server/routes/social.ts). The worker runs on the same tick as the
 * follow-up/BI jobs (src/server/jobs/scheduler.ts + /api/internal/tick):
 *
 *   runSocialPostScheduler()  picks due pending rows (status='pending' and
 *   scheduled_for <= now) and posts each through the SocialProvider interface.
 *
 * Every publish is:
 *   - tenant-scoped — postDueSocialPost() fetches the row by (businessId, id),
 *     so a row belonging to another business can never be posted through our
 *     scope; runSocialPostScheduler(businessId) also filters to one business,
 *   - posted via getSocialProvider() (mock default = a clearly-labeled sample
 *     publish recorded in the audit + status transition; a real API later via
 *     SOCIAL_PROVIDER env — config-only swap),
 *   - audited (agent_actions, success/failure),
 *   - notified (owner bell, kind "post_published"),
 *   - evented (POST_PUBLISHED, persisted + dispatched to the automation
 *     engine for future rules).
 *
 * Status lifecycle: pending → posting → posted | failed; a cancelled post is
 * skipped by the worker, never published.
 */
import * as repo from "../db/repo";
import { getSocialProvider } from "../integrations";
import { emitEvent } from "../ai/events";

export interface ScheduleSocialPostInput {
  /** facebook | instagram | linkedin | x */
  platform: string;
  /** The post copy / content. */
  message: string;
  /** Epoch ms the post becomes due — the worker publishes rows with scheduledFor <= now. */
  scheduledFor: number;
}

export interface ScheduleSocialPostResult {
  postId: string;
  platform: string;
  scheduledFor: number;
  status: string;
  provider: string;
}

/** Create a pending social_posts queue row. Tenant-scoped; audited by the caller (tool or route). */
export async function scheduleSocialPost(businessId: string, input: ScheduleSocialPostInput): Promise<ScheduleSocialPostResult> {
  const row = await repo.createSocialPost(businessId, {
    platform: input.platform,
    message: input.message,
    scheduledFor: input.scheduledFor,
    status: "pending",
    provider: getSocialProvider().name,
  });
  if (!row) throw new Error("social post not created");
  return { postId: row.id, platform: row.platform, scheduledFor: row.scheduledFor, status: row.status, provider: row.provider };
}

export interface PostSocialPostResult {
  postId: string;
  status: "posted" | "skipped" | "failed";
  provider?: string;
  externalId?: string;
  reason?: string;
  error?: string;
}

/**
 * Post ONE due social post. STRICTLY tenant-scoped: the row is fetched by
 * (businessId, id), so a foreign business's post (or a missing row) is a no-op.
 * Re-checks the row is still pending at fire time (a cancelled post never
 * publishes). On success: status → posted + postedAt + provider; audit +
 * owner notification + POST_PUBLISHED event. On provider failure: status →
 * failed with the error recorded.
 */
export async function postDueSocialPost(businessId: string, postId: string): Promise<PostSocialPostResult> {
  const post = await repo.getSocialPostById(businessId, postId);
  if (!post) return { postId, status: "skipped", reason: "not-found-or-foreign" };
  if (post.status !== "pending") return { postId, status: "skipped", reason: `status-${post.status}` };

  await repo.updateSocialPost(businessId, postId, { status: "posting" });
  const provider = getSocialProvider();
  try {
    const res = await provider.post({ businessId, platform: post.platform, message: post.message });
    await repo.updateSocialPost(businessId, postId, {
      status: "posted",
      postedAt: res.postedAt,
      provider: provider.name,
      error: null,
    });
    await repo.logAgentAction(businessId, {
      agent: "social",
      action: "post",
      leadId: undefined,
      input: { postId: post.id, platform: post.platform, message: post.message },
      result: { externalId: res.externalId, provider: provider.name, postedAt: res.postedAt, note: res.note },
      success: true,
    });
    await repo.createNotification(businessId, {
      kind: "post_published",
      title: `Published to ${post.platform}`,
      body: `${post.message.slice(0, 120)}${post.message.length > 120 ? "…" : ""}`,
    });
    await emitEvent({
      type: "POST_PUBLISHED",
      businessId,
      payload: { postId: post.id, platform: post.platform, provider: provider.name, externalId: res.externalId },
    });
    return { postId, status: "posted", provider: provider.name, externalId: res.externalId };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await repo.updateSocialPost(businessId, postId, { status: "failed", error: message });
    await repo.logAgentAction(businessId, {
      agent: "social",
      action: "post",
      leadId: undefined,
      input: { postId: post.id, platform: post.platform },
      result: { error: message.slice(0, 300) },
      success: false,
    });
    return { postId, status: "failed", error: message };
  }
}

export interface SocialSchedulerRun {
  checked: number;
  posted: number;
  skipped: number;
  failed: number;
  errors: number;
}

/**
 * The scheduled worker pass: post every due pending social post. When
 * `businessId` is provided it only processes that business's due posts (used
 * for strict tenant-isolated runs); otherwise it iterates all tenants' due
 * posts, posting each through its OWN business scope (postDueSocialPost is
 * tenant-scoped, so no cross-tenant leak is possible).
 */
export async function runSocialPostScheduler(nowMs = Date.now(), businessId?: string): Promise<SocialSchedulerRun> {
  const run: SocialSchedulerRun = { checked: 0, posted: 0, skipped: 0, failed: 0, errors: 0 };
  const due = await repo.listDueSocialPosts(100, nowMs, businessId);
  for (const post of due) {
    run.checked += 1;
    try {
      const res = await postDueSocialPost(post.businessId, post.id);
      if (res.status === "posted") run.posted += 1;
      else if (res.status === "failed") run.failed += 1;
      else run.skipped += 1;
    } catch (e) {
      run.errors += 1;
      console.error("[social] scheduler error:", e);
    }
  }
  return run;
}
