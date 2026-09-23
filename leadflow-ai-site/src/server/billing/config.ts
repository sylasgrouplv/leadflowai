/**
 * Billing configuration read by both the API and the client.
 *
 * Kept in its own tiny module (no route/guard imports) so `GET /api/auth/me`
 * can include the billing mode without a circular import with the billing
 * routes.
 *
 * Owner direction (BUILD 2): the 14-day free trial REQUIRES a card. The trial
 * still runs on the local clock (repo.getTrialState) — there is no Stripe
 * webhook in this build — while Stripe's `trial_period_days` contract owns the
 * charge that happens when the trial ends uncanceled.
 */
import { env } from "../env";
import { TRIAL_DAYS } from "../db/repo";

export interface BillingConfig {
  /** Selected Stripe provider name (mock-stripe | stripe-live). */
  provider: string;
  /** True when a real Stripe provider (not the mock) is selected. */
  live: boolean;
  /**
   * True when the card step is enforced: a live provider AND an API key are
   * configured. With the mock (the default, pre-keys) the card step is still
   * shown for a real trial clock, but no live charge machinery is involved.
   */
  cardRequired: boolean;
  /** Free-trial length in days (14) — the value sent as trial_period_days. */
  trialDays: number;
  /** True when every plan has a Stripe price id (STRIPE_PRICE_* / map). */
  pricesConfigured: boolean;
}

export function billingConfig(): BillingConfig {
  const provider = env.stripeProvider;
  const live = provider !== "mock";
  const pricesConfigured = [env.stripePriceStarter, env.stripePriceProfessional, env.stripePricePremium].every(
    Boolean
  );
  return {
    provider,
    live,
    cardRequired: live && !!env.stripeApiKey,
    trialDays: TRIAL_DAYS,
    pricesConfigured,
  };
}
