/** Dashboard routes — real aggregated queries, tenant-scoped. */
import { Hono } from "hono";
import * as repo from "../db/repo";
import { attachUser, resolveBusiness } from "../auth/guards";

export const dashboardRoutes = new Hono();
dashboardRoutes.use("*", attachUser);

dashboardRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const data = await repo.getDashboard(business.id);
  return c.json({
    businessId: business.id,
    businessName: business.name,
    ...data,
  });
});
