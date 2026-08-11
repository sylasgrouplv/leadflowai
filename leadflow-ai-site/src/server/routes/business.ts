/** Business routes: create, read, update info / service area / hours, complete onboarding. */
import { Hono } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, requireUser } from "../auth/guards";
import { serializeBusiness } from "./auth";
import { APP_TYPES } from "../db/schema";
import type { BusinessCategory } from "../db/schema";

const WEEKDAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

const categorySchema = z.enum(APP_TYPES as unknown as [BusinessCategory, ...BusinessCategory[]]);

const createSchema = z.object({
  name: z.string().min(2, "Business name is required").max(120),
  category: categorySchema.optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(254).optional().or(z.literal("")),
  website: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
});

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  category: categorySchema.optional(),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(254).optional().or(z.literal("")),
  website: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
});

const serviceAreaSchema = z.object({
  zipCodes: z.array(z.string().max(12)).max(200).default([]),
  cities: z.array(z.string().max(80)).max(200).default([]),
});

const daySchema = z.object({
  open: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use HH:MM 24h").or(z.literal("")),
  close: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use HH:MM 24h").or(z.literal("")),
  closed: z.boolean().default(false),
});

const hoursSchema = z.object({
  monday: daySchema, tuesday: daySchema, wednesday: daySchema, thursday: daySchema,
  friday: daySchema, saturday: daySchema, sunday: daySchema,
});

const policiesSchema = z.object({
  cancellationPolicy: z.string().max(2000).optional(),
  financing: z.string().max(2000).optional(),
  promotions: z.string().max(2000).optional(),
  welcomeMessage: z.string().max(2000).optional(),
});

export const businessRoutes = new Hono();
businessRoutes.use("*", attachUser);

// POST /api/business — create (onboarding step 1). One business per user for MVP.
businessRoutes.post("/", async (c) => {
  const user = await requireUser(c);
  if (user.role !== "owner") throw new HttpError(403, "Only business owners can create a business.");
  const existing = await repo.getBusinessForUser(user.id);
  if (existing) throw new HttpError(409, "You already have a business.");

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const business = await repo.createBusiness({ ownerId: user.id, ...parsed.data });
  await repo.audit(business.id, user.id, "business.create", "business", business.id, { name: business.name });
  return c.json({ business: serializeBusiness(business) }, 201);
});

// GET /api/business
businessRoutes.get("/", async (c) => {
  const user = await requireUser(c);
  const business = user.role === "admin" ? await repo.getBusinessById(c.req.query("businessId") ?? "") : await repo.getBusinessForUser(user.id);
  if (!business) return c.json({ business: null });
  return c.json({ business: serializeBusiness(business) });
});

// PATCH /api/business — update info (advances onboarding past step 1)
businessRoutes.patch("/", async (c) => {
  const user = await requireUser(c);
  const business = await repo.getBusinessForUser(user.id);
  if (!business) throw new HttpError(404, "No business yet.");
  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const updated = await repo.updateBusiness(business.id, parsed.data);
  if (updated && updated.onboardingStep < 2) await repo.advanceOnboarding(business.id, 2);
  await repo.audit(business.id, user.id, "business.update", "business", business.id, parsed.data);
  return c.json({ business: serializeBusiness((await repo.getBusinessById(business.id))!) });
});

// PUT /api/business/service-area (advances onboarding past step 3)
businessRoutes.put("/service-area", async (c) => {
  const user = await requireUser(c);
  const business = await repo.getBusinessForUser(user.id);
  if (!business) throw new HttpError(404, "No business yet.");
  const body = await c.req.json().catch(() => null);
  const parsed = serviceAreaSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  await repo.updateBusiness(business.id, { serviceAreaJson: JSON.stringify(parsed.data) });
  if (business.onboardingStep < 4) await repo.advanceOnboarding(business.id, 4);
  return c.json({ business: serializeBusiness((await repo.getBusinessById(business.id))!) });
});

// PUT /api/business/hours (advances onboarding past step 4)
businessRoutes.put("/hours", async (c) => {
  const user = await requireUser(c);
  const business = await repo.getBusinessForUser(user.id);
  if (!business) throw new HttpError(404, "No business yet.");
  const body = await c.req.json().catch(() => null);
  const parsed = hoursSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  await repo.updateBusiness(business.id, { hoursJson: JSON.stringify(parsed.data) });
  if (business.onboardingStep < 5) await repo.advanceOnboarding(business.id, 5);
  return c.json({ business: serializeBusiness((await repo.getBusinessById(business.id))!) });
});

// PUT /api/business/policies (knowledge-base policies; part of step 5)
businessRoutes.put("/policies", async (c) => {
  const user = await requireUser(c);
  const business = await repo.getBusinessForUser(user.id);
  if (!business) throw new HttpError(404, "No business yet.");
  const body = await c.req.json().catch(() => null);
  const parsed = policiesSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const current = JSON.parse(business.policiesJson || "{}");
  await repo.updateBusiness(business.id, { policiesJson: JSON.stringify({ ...current, ...parsed.data }) });
  return c.json({ business: serializeBusiness((await repo.getBusinessById(business.id))!) });
});

// POST /api/business/complete-onboarding
businessRoutes.post("/complete-onboarding", async (c) => {
  const user = await requireUser(c);
  const business = await repo.getBusinessForUser(user.id);
  if (!business) throw new HttpError(404, "No business yet.");
  const updated = await repo.advanceOnboarding(business.id, 6);
  await repo.audit(business.id, user.id, "onboarding.complete", "business", business.id, {});
  return c.json({ business: serializeBusiness(updated!) });
});

export { WEEKDAY_KEYS };
