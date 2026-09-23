/**
 * Stripe provider — mock (the DEFAULT; STRIPE_PROVIDER=mock).
 *
 * Keeps the card-gated trial flow fully testable end to end without Stripe
 * keys: it fabricates deterministic-looking customer/subscription/session ids
 * and returns a stub checkout URL. Nothing here talks to the network and no
 * mock id can ever be mistaken for a real Stripe object (every id carries the
 * `_mock_` marker).
 *
 * Behaviors mirror the live provider's contract (see ./stripe-live.ts) so the
 * billing routes behave identically in both modes — only the ids and the
 * checkout URL differ.
 */
import type {
  StripeProvider,
  StripeCustomerInput,
  StripeSubscriptionInput,
  StripeCheckoutInput,
  StripeCheckoutResult,
  StripeCheckoutDetails,
} from "./types";
import { randomUUID } from "node:crypto";

/** Default trial length used when a caller does not pass trialDays. */
export const MOCK_TRIAL_DAYS = 14;

export class MockStripeProvider implements StripeProvider {
  readonly name = "mock-stripe";
  async createCustomer(opts: StripeCustomerInput) {
    return { customerId: `cus_mock_${randomUUID().slice(0, 12)}` };
  }
  async createSubscription(_opts: StripeSubscriptionInput) {
    return { subscriptionId: `sub_mock_${randomUUID().slice(0, 12)}`, status: "trialing" };
  }
  async cancelSubscription(_subscriptionId: string) {
    return { ok: true as const };
  }
  async createCheckoutSession(opts: StripeCheckoutInput): Promise<StripeCheckoutResult> {
    // No live checkout until Stripe keys exist — the mock returns a stub URL
    // (plus its session id) so the flow is testable end-to-end without keys.
    const sessionId = `cs_mock_${randomUUID().slice(0, 12)}`;
    return {
      url: `/mock-checkout?businessId=${opts.businessId}&plan=${opts.plan}&session_id=${sessionId}`,
      sessionId,
    };
  }
  /** Deterministic ids derived from the mock session id (no network, no state). */
  async retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutDetails> {
    const seed = sessionId.replace(/^cs_mock_/, "") || "session";
    return {
      sessionId,
      customerId: `cus_mock_${seed}`,
      subscriptionId: `sub_mock_${seed}`,
      status: "trialing",
      trialEndsAt: null,
    };
  }
}
