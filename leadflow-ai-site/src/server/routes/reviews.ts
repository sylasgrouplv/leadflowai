/**
 * Review routes (spec §21) — AI BRAIN 4.
 *
 *   GET  /api/reviews              list recent feedback records (lead + service)
 *   POST /api/reviews/feedback     record a customer's feedback reply
 *                                  { review_id, feedback_text } → sentiment →
 *                                  positive: review link sent / negative: human
 *                                  task (never a public review link)
 *   POST /api/reviews/request      manually trigger the feedback request for a
 *                                  completed job { appointment_id } (test/owner)
 *   GET  /api/reviews/config       review workflow config (delay, review_url)
 *   PUT  /api/reviews/config       save config (syncs the automation rule delay)
 *
 * All mutations go through the tool registry (validated + tenant-scoped +
 * audited) — the registry is the only mutation path.
 */
import { Hono } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, resolveBusiness } from "../auth/guards";
import { callAiTool } from "../ai/tools/registry";
import { syncReviewRuleDelay } from "../automations/rules";

export const reviewRoutes = new Hono();
reviewRoutes.use("*", attachUser);

reviewRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const items = await repo.listReviews(business.id, 100);
  return c.json({ reviews: items });
});

const feedbackSchema = z.object({
  review_id: z.string().uuid("review_id is required"),
  feedback_text: z.string().trim().min(1, "Feedback cannot be empty").max(2000),
});

reviewRoutes.post("/feedback", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = feedbackSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const result = await callAiTool("record_feedback", { businessId: business.id, agent: "review" }, {
    review_id: parsed.data.review_id,
    feedback_text: parsed.data.feedback_text,
  });
  return c.json({ result }, 200);
});

const requestSchema = z.object({
  appointment_id: z.string().uuid("appointment_id is required"),
});

reviewRoutes.post("/request", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const result = await callAiTool("send_review_request", { businessId: business.id, agent: "review" }, { appointment_id: parsed.data.appointment_id });
  return c.json({ result }, 200);
});

reviewRoutes.get("/config", async (c) => {
  const business = await resolveBusiness(c);
  const config = await repo.getReviewConfig(business.id);
  return c.json({ config });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  delay_days: z.number().int().min(0).max(90).optional(),
  review_url: z.string().max(500).optional(),
});

reviewRoutes.put("/config", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const config = await repo.saveReviewConfig(business.id, {
    enabled: parsed.data.enabled,
    delayDays: parsed.data.delay_days,
    reviewUrl: parsed.data.review_url,
  });
  // Keep the JOB_COMPLETED automation rule's delay in sync with the config.
  await syncReviewRuleDelay(business.id);
  await repo.audit(business.id, null, "reviews.config", "review_config", business.id, { config });
  return c.json({ config });
});
