/**
 * Server-side authorization guards + lightweight rate limiting.
 *
 * Every authenticated route resolves its tenant (businessId) here and every
 * downstream repo call receives that businessId — the isolation backbone.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import { userFromRequest } from "./session";
import * as repo from "../db/repo";
import type { businesses, users } from "../db/schema";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(msg = "Not found"): never {
  throw new HttpError(404, msg);
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory; per IP). Good enough for the MVP, swap for a
// Redis-backed limiter when the app is multi-instance.
// ---------------------------------------------------------------------------

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(max: number, windowMs: number): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
    const key = `${ip}:${c.req.path}`;
    const nowT = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < nowT) {
      buckets.set(key, { count: 1, resetAt: nowT + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      throw new HttpError(429, "Too many requests — try again in a minute.");
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export type AppUser = Awaited<ReturnType<typeof repo.getUserById>> & object;
export type AppBusiness = typeof businesses.$inferSelect;

/** Sets c.set("user") — does not require auth; use with requireUser below. */
export const attachUser: MiddlewareHandler = async (c, next) => {
  const user = await userFromRequest(c);
  c.set("user", user);
  return next();
};

export async function requireUser(c: Context): Promise<NonNullable<AppUser>> {
  const user = c.get("user") as AppUser | null | undefined;
  if (!user) throw new HttpError(401, "Please log in.");
  return user;
}

export async function requireAdmin(c: Context): Promise<NonNullable<AppUser>> {
  const user = await requireUser(c);
  if (user.role !== "admin") throw new HttpError(403, "Admin access required.");
  return user;
}

/** The business the user belongs to (owner/employee). Admins pass without a business. */
export async function resolveBusiness(c: Context): Promise<AppBusiness> {
  const user = await requireUser(c);
  if (user.role === "admin") {
    const businessId = c.req.query("businessId") || c.req.header("x-business-id");
    if (businessId) {
      const b = await repo.getBusinessById(businessId);
      if (b) return b;
    }
    throw new HttpError(400, "Admins must target a businessId.");
  }
  const business = await repo.getBusinessForUser(user.id);
  if (!business) throw new HttpError(403, "No business found for this account — complete onboarding first.");
  return business;
}

/** Requires an owner (or admin) of the resolved business. */
export async function requireOwnerBusiness(c: Context): Promise<{ user: NonNullable<AppUser>; business: AppBusiness }> {
  const user = await requireUser(c);
  const business = await resolveBusiness(c);
  if (user.role === "admin") return { user, business };
  if (user.role !== "owner") throw new HttpError(403, "Owner access required.");
  return { user, business };
}
