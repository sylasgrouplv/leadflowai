/** Stripe provider — mock. Real Stripe later behind the same interface. */
import type { StripeProvider } from "./types";
import { randomUUID } from "node:crypto";

export class MockStripeProvider implements StripeProvider {
  readonly name = "mock-stripe";
  async createCustomer(opts: { email: string; name: string; businessId: string }) {
    return { customerId: `cus_mock_${randomUUID().slice(0, 12)}` };
  }
  async createSubscription(opts: { customerId: string; plan: string; businessId: string }) {
    return { subscriptionId: `sub_mock_${randomUUID().slice(0, 12)}`, status: "active" };
  }
  async cancelSubscription(subscriptionId: string) {
    return { ok: true as const };
  }
  async createCheckoutSession(opts: { businessId: string; plan: string; successUrl: string }) {
    // No live checkout in the MVP — the mock returns a stub URL so the flow
    // is testable end-to-end without Stripe keys.
    return { url: `/mock-checkout?businessId=${opts.businessId}&plan=${opts.plan}` };
  }
}
