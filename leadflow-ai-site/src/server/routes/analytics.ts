/**
 * Analytics routes — real DB aggregations for the /app/analytics page.
 * Everything is computed from the business's own rows (spec §19 dashboard).
 */
import { Hono } from "hono";
import * as repo from "../db/repo";
import { attachUser, requireOwnerBusiness } from "../auth/guards";

export const analyticsRoutes = new Hono();
analyticsRoutes.use("*", attachUser);

analyticsRoutes.get("/", async (c) => {
  const { business } = await requireOwnerBusiness(c);
  const data = await repo.getAnalytics(business.id);
  return c.json({ businessId: business.id, businessName: business.name, ...data });
});
