/**
 * Billing routes — the card-gated 14-day free trial (owner direction, BUILD 2).
 *
 * The trial now REQUIRES a card, modelled as a real Stripe subscription with
 * `trial_period_days = 14` (see src/server/integrations/stripe-live.ts):
 *
 *   POST /api/billing/trial-checkout  → hosted checkout URL (card collected,
 *                                       $0 charged today, trial starts on return)
 *   POST /api/billing/trial-confirm   → verifies the completed session and stores
 *                                       stripeCustomerId + stripeSubscriptionId
 *   GET  /api/billing/config          → the mode the UI needs (provider, trial
 *                                       length, whether live prices are set)
 *
 * Provider-mock (the default, pre-keys) behavior is identical in shape — the
 * mock returns a stub checkout URL and deterministic ids — so the flow is
 * testable end-to-end without Stripe keys, and CI stays unchanged.
 *
 * No price ids, URLs or keys are invented here: prices come from env, and the
 * redirect URLs are built from the request's own origin.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, requireUser } from "../auth/guards";
import { getStripeProvider } from "../integrations";
import { billingConfig } from "../billing/config";
import { serializeSubscription } from "./auth";

export const billingRoutes = new Hono();
billingRoutes.use("*", attachUser);

/**
 * Absolute origin of the running app, used for the provider's success/cancel
 * redirect URLs. Derived from the request (the public proxy terminates TLS and
 * forwards the original proto), never hard-coded.
 */
function appOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
}

const confirmSchema = z.object({
  /** Stripe checkout session id (the mock returns its own `cs_mock_…`). */
  sessionId: z.string().min(4, "A checkout session id is required").max(200),
});

/** GET /api/billing/config — the billing mode (provider, trial length, prices). */
billingRoutes.get("/config", async (c) => {
  await requireUser(c);
  return c.json(billingConfig());
});

/**
 * POST /api/billing/trial-checkout — start the card-required trial.
 * Creates (or reuses) the provider customer, then returns the hosted checkout
 * URL the client redirects to. The trial itself starts when checkout completes.
 */
billingRoutes.post("/trial-checkout", async (c) => {
  const user = await requireUser(c);
  const business = await repo.getBusinessForUser(user.id);
  if (!business) throw new HttpError(404, "No business yet.");
  const subscription = await repo.getSubscription(business.id);
  if (!subscription) throw new HttpError(404, "No subscription found for this business.");
  const provider = getStripeProvider();

  // Reuse the provider customer if checkout was started before, so a retry
  // never creates a duplicate customer for the same business.
  let customerId = subscription.stripeCustomerId || "";
  if (!customerId) {
    const customer = await provider.createCustomer({
      email: business.email || user.email,
      name: business.name,
      businessId: business.id,
    });
    customerId = customer.customerId;
    await repo.setSubscriptionStripeIds(business.id, { stripeCustomerId: customerId });
  }

  const origin = appOrigin(c);
  const session = await provider.createCheckoutSession({
    businessId: business.id,
    plan: subscription.plan,
    customerId,
    trialDays: repo.TRIAL_DAYS,
    // {CHECKOUT_SESSION_ID} is Stripe's own placeholder — Stripe replaces it
    // with the real session id on the success redirect, which /trial-confirm
    // then verifies before storing anything.
    successUrl: `${origin}/app?trial_session={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/app`,
    metadata: { businessId: business.id },
  });

  await repo.audit(business.id, user.id, "subscription.trial_checkout", "subscription", subscription.id, {
    plan: subscription.plan,
    provider: provider.name,
    sessionId: session.sessionId ?? "",
    trialDays: repo.TRIAL_DAYS,
    charged: false,
  });

  return c.json({
    url: session.url,
    sessionId: session.sessionId ?? "",
    ...billingConfig(),
  });
});

/**
 * POST /api/billing/trial-confirm — verify a completed checkout session and
 * store the provider ids on the subscription row. Nothing is charged here: the
 * card is on file, $0 was taken today, and the first charge belongs to Stripe's
 * trial_period_days contract when the trial ends uncanceled.
 */
billingRoutes.post("/trial-confirm", async (c) => {
  const user = await requireUser(c);
  const business = await repo.getBusinessForUser(user.id);
  if (!business) throw new HttpError(404, "No business yet.");
  const subscription = await repo.getSubscription(business.id);
  if (!subscription) throw new HttpError(404, "No subscription found for this business.");

  const body = await c.req.json().catch(() => null);
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? "A checkout session id is required");
  }

  const provider = getStripeProvider();
  if (!provider.retrieveCheckoutSession) {
    throw new HttpError(
      503,
      `Stripe provider "${provider.name}" cannot verify checkout sessions — set STRIPE_PROVIDER=live with STRIPE_API_KEY, or use the mock.`
    );
  }
  const details = await provider.retrieveCheckoutSession(parsed.data.sessionId);

  const updated = await repo.setSubscriptionStripeIds(business.id, {
    stripeCustomerId: details.customerId,
    stripeSubscriptionId: details.subscriptionId,
  });
  if (!updated) throw new HttpError(404, "No subscription found for this business.");

  await repo.audit(business.id, user.id, "subscription.trial_confirm", "subscription", updated.id, {
    sessionId: details.sessionId,
    provider: provider.name,
    status: details.status,
    trialDays: repo.TRIAL_DAYS,
    charged: false,
  });

  return c.json({ subscription: serializeSubscription(updated) });
});
