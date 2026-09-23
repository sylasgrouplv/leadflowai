/**
 * Stripe provider — LIVE (owner direction, BUILD 2: the 14-day free trial
 * requires a card).
 *
 * Registered behind STRIPE_PROVIDER=live. When STRIPE_API_KEY is set, this
 * provider talks to Stripe's REST API (`https://api.stripe.com/v1/...`) with
 * plain `fetch` + form-encoded bodies — no `stripe` npm dependency, so the
 * serverless bundle stays small (same choice as the OpenAI/Anthropic providers).
 *
 * The mock (STRIPE_PROVIDER=mock) remains the DEFAULT, so CI and the current
 * app behavior are unchanged until an operator explicitly sets BOTH
 * STRIPE_PROVIDER=live and STRIPE_API_KEY — a config-only swap, no code change.
 *
 * Trial contract (matches what the marketing site and Terms promise):
 *   - the trial is a real subscription with `trial_period_days = 14`,
 *   - $0 is charged during the trial; the first charge happens only when the
 *     trial ends,
 *   - cancelling before the trial ends means never being charged — the cancel
 *     path deletes the subscription.
 *
 * Price ids are NEVER hard-coded: they come from env
 * (STRIPE_PRICE_STARTER / STRIPE_PRICE_PROFESSIONAL / STRIPE_PRICE_PREMIUM or
 * the STRIPE_PRICES_JSON map). Missing key or missing plan price → a clear
 * "not configured" error, never a silent fall back to the mock.
 *
 * Env: STRIPE_PROVIDER=live, STRIPE_API_KEY (required),
 *      STRIPE_PRICE_STARTER / STRIPE_PRICE_PROFESSIONAL / STRIPE_PRICE_PREMIUM
 *      (or STRIPE_PRICES_JSON).
 */
import type {
  StripeProvider,
  StripeCustomerInput,
  StripeSubscriptionInput,
  StripeCheckoutInput,
  StripeCheckoutResult,
  StripeCheckoutDetails,
} from "./types";
import { PLAN_NAMES } from "../db/schema.sqlite";
import { env } from "../env";

export const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
/** Free-trial length (Stripe `trial_period_days`) — mirrors repo.TRIAL_DAYS. */
export const STRIPE_TRIAL_DAYS = 14;

const NOT_CONFIGURED =
  "Stripe provider 'live' is not configured — set STRIPE_API_KEY and STRIPE_PROVIDER=live to enable it. " +
  "The mock provider (STRIPE_PROVIDER=mock, the default) keeps the app fully functional in the meantime.";

/** Plan → env-var name for the price id (no price ids live in source). */
export const PLAN_PRICE_ENV: Record<string, string> = {
  starter: "STRIPE_PRICE_STARTER",
  professional: "STRIPE_PRICE_PROFESSIONAL",
  premium: "STRIPE_PRICE_PREMIUM",
};

export function priceNotConfiguredError(plan: string): Error {
  const varName = PLAN_PRICE_ENV[plan];
  return new Error(
    `Stripe price id for plan "${plan}" is not configured — set ${varName ?? `STRIPE_PRICE_${plan.toUpperCase()}`} ` +
      `(or the STRIPE_PRICES_JSON map) to enable live billing. No request was sent to Stripe.`
  );
}

/**
 * Resolve the plan → price-id map from env: STRIPE_PRICES_JSON entries win over
 * the individual STRIPE_PRICE_* variables, so an operator can override one plan
 * without repeating all three.
 */
export function liveStripePriceMap(override?: Record<string, string>): Record<string, string> {
  if (override) return { ...override };
  let fromJson: Record<string, string> = {};
  if (env.stripePricesJson) {
    try {
      const parsed = JSON.parse(env.stripePricesJson) as unknown;
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string" && v) fromJson[k] = v;
        }
      }
    } catch {
      // A malformed map must not crash the process — the per-plan error below
      // tells the operator exactly which variable is missing.
      fromJson = {};
    }
  }
  return {
    starter: fromJson.starter || env.stripePriceStarter,
    professional: fromJson.professional || env.stripePriceProfessional,
    premium: fromJson.premium || env.stripePricePremium,
  };
}

export class StripeApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Stripe API error ${status}: ${body.slice(0, 300)}`);
    this.name = "StripeApiError";
    this.status = status;
    this.body = body;
  }
}

export function isStripeApiError(e: unknown): e is StripeApiError {
  return e instanceof StripeApiError;
}

export interface LiveStripeOptions {
  /** Explicit key (hermetic tests pass "" to force the not-configured path). */
  apiKey?: string;
  baseUrl?: string;
  /** Inject a fake fetch in tests. */
  fetchImpl?: typeof fetch;
  /** Explicit plan → price id map (tests); defaults to the env map. */
  prices?: Record<string, string>;
}

export class LiveStripeProvider implements StripeProvider {
  readonly name = "stripe-live";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly prices: Record<string, string>;

  constructor(opts: LiveStripeOptions = {}) {
    // `??` on purpose: an explicitly-passed empty string must NOT fall through
    // to the environment (hermetic tests force the no-key behavior).
    this.apiKey = (opts.apiKey ?? env.stripeApiKey) ?? "";
    this.baseUrl = (opts.baseUrl ?? STRIPE_API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.prices = liveStripePriceMap(opts.prices);
  }

  /** The price id for a plan, or a clear "set STRIPE_PRICE_*" error. */
  priceIdForPlan(plan: string): string {
    if (!(PLAN_NAMES as readonly string[]).includes(plan)) {
      throw new Error(
        `Stripe billing got an unknown plan "${plan}" — expected one of ${PLAN_NAMES.join(", ")}.`
      );
    }
    const priceId = this.prices[plan];
    if (!priceId) throw priceNotConfiguredError(plan);
    return priceId;
  }

  private authorize(): void {
    if (!this.apiKey) throw new Error(NOT_CONFIGURED);
  }

  private async request<T>(method: string, path: string, body?: string): Promise<T> {
    this.authorize();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        ...(body ? { body } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Stripe network error: ${msg}`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new StripeApiError(res.status, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Stripe returned an unparseable response body (HTTP ${res.status})`);
    }
  }

  async createCustomer(opts: StripeCustomerInput): Promise<{ customerId: string }> {
    const data: Record<string, string> = {
      email: opts.email,
      name: opts.name,
      "metadata[businessId]": opts.businessId,
    };
    const res = await this.request<{ id: string }>("POST", "/customers", form(data));
    return { customerId: res.id };
  }

  async createSubscription(
    opts: StripeSubscriptionInput
  ): Promise<{ subscriptionId: string; status: string }> {
    const priceId = opts.priceId ?? this.priceIdForPlan(opts.plan);
    const data: Record<string, string> = {
      customer: opts.customerId,
      "items[0][price]": priceId,
      trial_period_days: String(opts.trialDays ?? STRIPE_TRIAL_DAYS),
      "metadata[businessId]": opts.businessId,
      ...opts.metadata,
    };
    // A card collected at checkout is attached as the subscription's default
    // payment method so the first charge lands when the trial ends.
    if (opts.paymentMethodId) data.default_payment_method = opts.paymentMethodId;
    const res = await this.request<{ id: string; status: string }>("POST", "/subscriptions", form(data));
    return { subscriptionId: res.id, status: res.status };
  }

  async cancelSubscription(subscriptionId: string): Promise<{ ok: true }> {
    await this.request("DELETE", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    return { ok: true as const };
  }

  async createCheckoutSession(opts: StripeCheckoutInput): Promise<StripeCheckoutResult> {
    const priceId = this.priceIdForPlan(opts.plan);
    const data: Record<string, string> = {
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "subscription_data[trial_period_days]": String(opts.trialDays ?? STRIPE_TRIAL_DAYS),
      success_url: opts.successUrl,
      client_reference_id: opts.businessId,
      "metadata[businessId]": opts.businessId,
      "subscription_data[metadata][businessId]": opts.businessId,
      ...opts.metadata,
    };
    if (opts.cancelUrl) data.cancel_url = opts.cancelUrl;
    if (opts.customerId) data.customer = opts.customerId;
    const res = await this.request<{ id: string; url: string }>("POST", "/checkout/sessions", form(data));
    return { url: res.url, sessionId: res.id };
  }

  async retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutDetails> {
    const res = await this.request<{
      id: string;
      customer?: string | { id?: string };
      subscription?: string | { id?: string; status?: string; trial_end?: number | null };
      status?: string;
    }>("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`);
    const customerId = typeof res.customer === "string" ? res.customer : res.customer?.id ?? "";
    const subscription = res.subscription;
    const subscriptionId = typeof subscription === "string" ? subscription : subscription?.id ?? "";
    const status = (typeof subscription === "object" && subscription?.status) || res.status || "";
    const trialEnd = typeof subscription === "object" ? subscription?.trial_end : null;
    if (!customerId || !subscriptionId) {
      throw new Error(
        `Stripe checkout session ${sessionId} has no customer/subscription yet — ` +
          "the customer may not have completed checkout. No card was stored."
      );
    }
    return {
      sessionId: res.id,
      customerId,
      subscriptionId,
      status,
      trialEndsAt: trialEnd ? trialEnd * 1000 : null,
    };
  }
}

/**
 * Stripe's REST API takes application/x-www-form-urlencoded bodies with
 * bracketed keys (`line_items[0][price]`). Values are encoded; undefined/empty
 * values are dropped so an unset option never sends `key=`.
 */
export function form(params: Record<string, string | undefined | null>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join("&");
}
