/**
 * AI agent configuration routes (spec §6/§13 — "configure AI" owner action).
 *
 *   GET /api/ai/config    owner: current receptionist config + welcome message
 *   PUT /api/ai/config    owner: update autoRespond / escalationSensitivity /
 *                                escalationKeywords / welcomeMessage
 *
 * The config is real and engine-backed:
 *   - autoRespond            -> new conversations start AI-handled or human-held
 *   - escalationSensitivity  -> fed into the AI provider's escalate decision
 *   - escalationKeywords     -> owner phrases that always escalate
 *   - welcomeMessage         -> stored in the business policies (the same field
 *                               the engine reads for the first AI message)
 */
import { Hono } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, requireOwnerBusiness } from "../auth/guards";

const updateSchema = z.object({
  autoRespond: z.boolean().optional(),
  escalationSensitivity: z.enum(["low", "medium", "high"]).optional(),
  escalationKeywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  welcomeMessage: z.string().max(2000).optional(),
});

export const aiRoutes = new Hono();
aiRoutes.use("*", attachUser);

aiRoutes.get("/config", async (c) => {
  const { business } = await requireOwnerBusiness(c);
  const config = await repo.getAiConfig(business.id);
  const policies = safeJson<{ welcomeMessage?: string }>(business.policiesJson, {});
  return c.json({ config, welcomeMessage: policies.welcomeMessage ?? "" });
});

aiRoutes.put("/config", async (c) => {
  const { business, user } = await requireOwnerBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const patch: Partial<repo.AiConfig> = {};
  if (parsed.data.autoRespond !== undefined) patch.autoRespond = parsed.data.autoRespond;
  if (parsed.data.escalationSensitivity !== undefined) patch.escalationSensitivity = parsed.data.escalationSensitivity;
  if (parsed.data.escalationKeywords !== undefined) patch.escalationKeywords = parsed.data.escalationKeywords;
  const config = await repo.saveAiConfig(business.id, patch);

  // Welcome message lives in the business policies — the same JSON the engine
  // reads when opening a new conversation (single source of truth).
  if (parsed.data.welcomeMessage !== undefined) {
    const current = safeJson<Record<string, unknown>>(business.policiesJson, {});
    await repo.updateBusiness(business.id, {
      policiesJson: JSON.stringify({ ...current, welcomeMessage: parsed.data.welcomeMessage }),
    });
  }

  await repo.audit(business.id, user.id, "ai.config_updated", "business", business.id, { patch: Object.keys(patch) });
  const fresh = await repo.getBusinessById(business.id);
  const policies = safeJson<{ welcomeMessage?: string }>(fresh?.policiesJson ?? "", {});
  return c.json({ config, welcomeMessage: policies.welcomeMessage ?? "" });
});

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
