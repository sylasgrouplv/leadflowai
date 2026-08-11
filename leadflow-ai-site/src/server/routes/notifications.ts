/**
 * Notification routes — in-app notification bell API.
 *
 *   GET    /api/notifications?limit=20    list (newest first)
 *   GET    /api/notifications/unread      unread count
 *   POST   /api/notifications/:id/read    mark one read
 *   POST   /api/notifications/read-all    mark all read
 */
import { Hono } from "hono";
import * as repo from "../db/repo";
import { attachUser, requireUser, resolveBusiness } from "../auth/guards";

export const notificationRoutes = new Hono();
notificationRoutes.use("*", attachUser);

notificationRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  const [notifications, unread] = await Promise.all([
    repo.listNotifications(business.id, limit),
    repo.countUnreadNotifications(business.id),
  ]);
  return c.json({ notifications, unread });
});

notificationRoutes.get("/unread", async (c) => {
  const business = await resolveBusiness(c);
  const unread = await repo.countUnreadNotifications(business.id);
  return c.json({ unread });
});

notificationRoutes.post("/:id/read", async (c) => {
  const business = await resolveBusiness(c);
  await requireUser(c);
  await repo.markNotificationRead(business.id, c.req.param("id"));
  return c.json({ ok: true });
});

notificationRoutes.post("/read-all", async (c) => {
  const business = await resolveBusiness(c);
  await requireUser(c);
  await repo.markAllNotificationsRead(business.id);
  return c.json({ ok: true });
});
