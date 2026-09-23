/** Auth routes: signup, login, logout, me. */
import { Hono } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { hashPassword, verifyPassword } from "../auth/password";
import { clearSessionCookie, createSession, destroySession, setSessionCookie, SESSION_COOKIE } from "../auth/session";
import { attachUser, HttpError, rateLimit, requireUser } from "../auth/guards";
import { getCookie } from "hono/cookie";
import { billingConfig } from "../billing/config";

const signupSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  email: z.string().email("Enter a valid email").max(254),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});

const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export const authRoutes = new Hono();

authRoutes.use("*", rateLimit(30, 60_000));

authRoutes.post("/signup", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const { name, email, password } = parsed.data;
  const existing = await repo.getUserByEmail(email);
  if (existing) throw new HttpError(409, "An account with this email already exists.");

  const user = await repo.createUser({ name, email, passwordHash: hashPassword(password), role: "owner" });
  const { token, expiresAt } = await createSession(user.id);
  setSessionCookie(c, token, expiresAt);
  await repo.audit(null, user.id, "auth.signup", "user", user.id, { email });

  return c.json({ user: publicUser(user) });
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const { email, password } = parsed.data;
  const user = await repo.getUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new HttpError(401, "Invalid email or password.");
  }
  const { token, expiresAt } = await createSession(user.id);
  setSessionCookie(c, token, expiresAt);
  await repo.audit(null, user.id, "auth.login", "user", user.id, {});

  return c.json({ user: publicUser(user) });
});

authRoutes.post("/logout", attachUser, async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  await destroySession(token ?? "");
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get("/me", attachUser, async (c) => {
  const user = await requireUser(c);
  const business = user.role === "admin" ? null : await repo.getBusinessForUser(user.id);
  const subscription = business ? await repo.getSubscription(business.id) : null;
  return c.json({
    user: publicUser(user),
    business: business ? serializeBusiness(business) : null,
    subscription: subscription ? serializeSubscription(subscription) : null,
    // Card-gated trial mode (BUILD 2) — the client shows the card step from this.
    billing: billingConfig(),
  });
});

export function publicUser(u: NonNullable<Awaited<ReturnType<typeof repo.getUserById>>>) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
}

/**
 * Subscription payload for the client. Backward compatible (plan + status are
 * still first-class) plus the free-trial clock: currentPeriodEnd (null = no
 * clock set, i.e. an account that never expires) and the derived trialState.
 * `cardOnFile` is the card-gated trial flag (BUILD 2): true once Stripe
 * Checkout has stored a customer/subscription for this business.
 */
export function serializeSubscription(sub: NonNullable<Awaited<ReturnType<typeof repo.getSubscription>>>) {
  return {
    plan: sub.plan,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd ?? null,
    trialState: repo.getTrialState(sub),
    cardOnFile: !!sub.stripeSubscriptionId,
  };
}

export function serializeBusiness(b: NonNullable<Awaited<ReturnType<typeof repo.getBusinessById>>>) {
  return {
    id: b.id,
    name: b.name,
    category: b.category,
    phone: b.phone,
    email: b.email,
    website: b.website,
    description: b.description,
    serviceArea: safeJson(b.serviceAreaJson, { zipCodes: [], cities: [] }),
    hours: safeJson(b.hoursJson, {}),
    policies: safeJson(b.policiesJson, { cancellationPolicy: "", financing: "", promotions: "", welcomeMessage: "" }),
    onboardingStep: b.onboardingStep,
    onboardingCompleted: b.onboardingCompleted === 1,
    createdAt: b.createdAt,
  };
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
