/** Knowledge base routes — CRUD + bulk save (onboarding step 5). */
import { Hono } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, resolveBusiness } from "../auth/guards";

const entrySchema = z.object({
  kind: z.enum(["faq", "policy", "service_info", "general"]).default("faq"),
  question: z.string().max(300).optional().default(""),
  answer: z.string().min(1, "Answer is required").max(4000),
});

const bulkSchema = z.object({
  entries: z.array(entrySchema).max(200),
});

export const knowledgeRoutes = new Hono();
knowledgeRoutes.use("*", attachUser);

knowledgeRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const entries = await repo.listKnowledge(business.id);
  return c.json({ entries });
});

knowledgeRoutes.post("/", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = entrySchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const entry = await repo.addKnowledge(business.id, parsed.data);
  return c.json({ entry }, 201);
});

// PUT /api/knowledge/bulk — replace all KB entries (onboarding step 5)
knowledgeRoutes.put("/bulk", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const entries = await repo.replaceKnowledge(business.id, parsed.data.entries);
  return c.json({ entries });
});

knowledgeRoutes.patch("/:id", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = entrySchema.partial().safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const entry = await repo.updateKnowledge(business.id, c.req.param("id"), parsed.data);
  if (!entry) throw new HttpError(404, "Knowledge entry not found");
  return c.json({ entry });
});

knowledgeRoutes.delete("/:id", async (c) => {
  const business = await resolveBusiness(c);
  await repo.deleteKnowledge(business.id, c.req.param("id"));
  return c.json({ ok: true });
});
