/** Service routes — CRUD, tenant-scoped. */
import { Hono } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, resolveBusiness } from "../auth/guards";

const serviceSchema = z.object({
  name: z.string().min(1, "Service name is required").max(120),
  description: z.string().max(1000).optional().default(""),
  /** price in cents; 0 = call for pricing */
  priceCents: z.number().int().min(0).max(100_000_000).optional().default(0),
  durationMin: z.number().int().min(5).max(600).optional().default(60),
  /** revenue attribution (spec §23): configured average job value; 0 = use priceCents */
  averageValueCents: z.number().int().min(0).max(100_000_000).optional().default(0),
});

const bulkSchema = z.object({
  services: z.array(serviceSchema).max(100),
});

export const serviceRoutes = new Hono();
serviceRoutes.use("*", attachUser);

serviceRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const services = await repo.listServices(business.id);
  return c.json({ services });
});

serviceRoutes.post("/", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = serviceSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const service = await repo.addService(business.id, parsed.data);
  return c.json({ service }, 201);
});

// PUT /api/services/bulk — replace all services (used by onboarding step 2)
serviceRoutes.put("/bulk", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const services = await repo.replaceServices(business.id, parsed.data.services);
  if (business.onboardingStep < 3) await repo.advanceOnboarding(business.id, 3);
  return c.json({ services });
});

serviceRoutes.patch("/:id", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = serviceSchema.partial().safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const service = await repo.updateService(business.id, c.req.param("id"), parsed.data);
  if (!service) throw new HttpError(404, "Service not found");
  return c.json({ service });
});

serviceRoutes.delete("/:id", async (c) => {
  const business = await resolveBusiness(c);
  await repo.deleteService(business.id, c.req.param("id"));
  return c.json({ ok: true });
});
