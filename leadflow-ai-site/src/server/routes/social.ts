/**
 * Social scheduling routes (in-app surface for the social_posts queue).
 *
 *   GET    /api/social                       list the business's post queue
 *   POST   /api/social                       schedule a post (owner)
 *   POST   /api/social/:id/cancel            cancel a pending post (owner)
 *
 * Owners: everything. Employees: read-only list. Mirror of routes/followups.ts
 * style — tenant-scoped via resolveBusiness(); scheduling goes through the same
 * social engine used by the `schedule_social_post` WRITE tool, so the in-app
 * and AI paths share one mutation choke point.
 */
import { Hono } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, resolveBusiness, requireOwnerBusiness } from "../auth/guards";
import { scheduleSocialPost } from "../social/engine";

const createSchema = z.object({
  platform: z.enum(["facebook", "instagram", "linkedin", "x"]),
  message: z.string().trim().min(1).max(2000),
  scheduledFor: z.number().int().positive(),
});

export const socialRoutes = new Hono();
socialRoutes.use("*", attachUser);

socialRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const posts = await repo.listSocialPosts(business.id);
  return c.json({ posts });
});

socialRoutes.post("/", async (c) => {
  const { business } = await requireOwnerBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const result = await scheduleSocialPost(business.id, parsed.data);
  await repo.logAgentAction(business.id, {
    agent: "social",
    action: "schedule_social_post",
    leadId: undefined,
    input: { via: "route", platform: parsed.data.platform, scheduledFor: parsed.data.scheduledFor },
    result: { postId: result.postId, status: result.status },
    success: true,
  });
  return c.json(result, 201);
});

socialRoutes.post("/:id/cancel", async (c) => {
  const { business } = await requireOwnerBusiness(c);
  const updated = await repo.cancelSocialPost(business.id, c.req.param("id"));
  if (!updated) throw new HttpError(404, "Social post not found");
  await repo.logAgentAction(business.id, {
    agent: "social",
    action: "cancel_social_post",
    leadId: undefined,
    input: { postId: updated.id },
    result: { ok: true, status: updated.status },
    success: true,
  });
  return c.json({ post: updated });
});
