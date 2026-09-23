/**
 * Live Stripe provider tests (BUILD 2 — card-gated 14-day trial).
 *
 * Hermetic: no network, no keys, no database. A fake `fetch` records every
 * request so the assertions are about the exact Stripe REST contract:
 *
 *   - plan → price id resolution from env (STRIPE_PRICE_* / STRIPE_PRICES_JSON),
 *     never hard-coded, with a clear error when a price is missing,
 *   - no API key → a clear "set STRIPE_API_KEY" error (never a silent mock),
 *   - createCustomer  → POST /v1/customers (form-encoded, Bearer auth),
 *   - createSubscription → POST /v1/subscriptions with trial_period_days=14,
 *     items[0][price], metadata[businessId] and the optional payment method,
 *   - cancelSubscription → DELETE /v1/subscriptions/{id},
 *   - createCheckoutSession → POST /v1/checkout/sessions, mode=subscription,
 *     subscription_data[trial_period_days]=14, success/cancel URLs, customer,
 *   - retrieveCheckoutSession → GET /v1/checkout/sessions/{id} (expand
 *     subscription) mapped to our customer/subscription/status/trialEndsAt,
 *   - Stripe API errors surface as StripeApiError with the HTTP status,
 *   - the mock provider's contract is unchanged (default provider),
 *   - the registry: STRIPE_PROVIDER=live selects the live provider (in a child
 *     process, because the registry caches one provider per process).
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && bun run stripe-live-test.ts
 */
import {
  LiveStripeProvider,
  StripeApiError,
  STRIPE_API_BASE_URL,
  liveStripePriceMap,
  form,
} from "./src/server/integrations/stripe-live";
import { MockStripeProvider } from "./src/server/integrations/stripe";
import { env } from "./src/server/env";

let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Fake fetch that records calls and returns canned JSON per call. */
function fakeFetch(responder: (call: Call) => { status?: number; json?: unknown; text?: string }) {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const res = responder(call);
    const status = res.status ?? 200;
    const text = res.text !== undefined ? res.text : JSON.stringify(res.json ?? {});
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Parse a form-encoded body into a plain object (no nested unflattening). */
function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

console.log("=== Live Stripe provider (card-gated trial) ===");

// ------------------------------------------------ L1: form encoding helper
const encoded = form({ "line_items[0][price]": "price_123", empty: "", missing: undefined, mode: "subscription" });
pass(
  "L0a form() encodes bracketed keys and drops empty values",
  encoded === "line_items%5B0%5D%5Bprice%5D=price_123&mode=subscription",
  encoded
);

// ------------------------------------------------ L1: price map from env
process.env.STRIPE_PRICE_STARTER = "price_starter_env";
process.env.STRIPE_PRICE_PROFESSIONAL = "price_pro_env";
process.env.STRIPE_PRICE_PREMIUM = "price_premium_env";
delete process.env.STRIPE_PRICES_JSON;
const envMap = liveStripePriceMap();
pass(
  "L1a price ids come from STRIPE_PRICE_* env vars",
  envMap.starter === "price_starter_env" && envMap.professional === "price_pro_env" && envMap.premium === "price_premium_env",
  JSON.stringify(envMap)
);
process.env.STRIPE_PRICES_JSON = '{"premium":"price_premium_json"}';
const jsonMap = liveStripePriceMap();
pass(
  "L1b STRIPE_PRICES_JSON overrides the per-plan variable",
  jsonMap.premium === "price_premium_json" && jsonMap.starter === "price_starter_env",
  JSON.stringify(jsonMap)
);
// A malformed map must not crash: the per-plan error still names the variable.
process.env.STRIPE_PRICES_JSON = "{not json";
const brokenMap = liveStripePriceMap();
pass("L1c a malformed STRIPE_PRICES_JSON falls back to the per-plan vars", brokenMap.starter === "price_starter_env", JSON.stringify(brokenMap));
delete process.env.STRIPE_PRICES_JSON;

// ------------------------------------------ L2: missing price → clear error
{
  const { impl, calls } = fakeFetch(() => ({ json: { id: "cus_x" } }));
  delete process.env.STRIPE_PRICE_PROFESSIONAL;
  const provider = new LiveStripeProvider({ apiKey: "sk_test_key", fetchImpl: impl });
  let msg = "";
  try {
    await provider.createCheckoutSession({ businessId: "b1", plan: "professional", successUrl: "https://x/s" });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  pass(
    "L2a a missing plan price throws a clear STRIPE_PRICE_* error",
    msg.includes("STRIPE_PRICE_PROFESSIONAL") && msg.includes("not configured"),
    msg.slice(0, 140)
  );
  pass("L2b no request is sent to Stripe when the price is missing", calls.length === 0, `calls=${calls.length}`);
  process.env.STRIPE_PRICE_PROFESSIONAL = "price_pro_env";
}

// ------------------------------------------ L3: no key → clear error, no call
{
  const { impl, calls } = fakeFetch(() => ({ json: {} }));
  const provider = new LiveStripeProvider({ apiKey: "", fetchImpl: impl });
  let msg = "";
  try {
    await provider.createCustomer({ email: "a@b.com", name: "A", businessId: "b1" });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  pass(
    "L3a STRIPE_PROVIDER=live without a key throws a clear STRIPE_API_KEY error",
    msg.includes("STRIPE_API_KEY") && msg.includes("not configured"),
    msg.slice(0, 140)
  );
  pass("L3b no request is sent when the key is missing (no silent mock)", calls.length === 0, `calls=${calls.length}`);
}

// ------------------------------------------------ L4: createCustomer
{
  const { impl, calls } = fakeFetch((call) => {
    if (call.url.endsWith("/customers")) return { json: { id: "cus_123" } };
    return { json: {} };
  });
  const provider = new LiveStripeProvider({ apiKey: "sk_test_key", fetchImpl: impl });
  const res = await provider.createCustomer({ email: "owner@acme.com", name: "Acme HVAC", businessId: "biz_1" });
  const call = calls[0];
  const body = parseForm(call.body);
  pass("L4a createCustomer → POST /v1/customers", call.method === "POST" && call.url === `${STRIPE_API_BASE_URL}/customers`, `${call.method} ${call.url}`);
  pass("L4b createCustomer sends Bearer auth + form content-type", call.headers.authorization === "Bearer sk_test_key" && call.headers["content-type"] === "application/x-www-form-urlencoded", JSON.stringify(call.headers));
  pass(
    "L4c createCustomer sends email, name and metadata[businessId]",
    body.email === "owner@acme.com" && body.name === "Acme HVAC" && body["metadata[businessId]"] === "biz_1",
    call.body
  );
  pass("L4d createCustomer returns the customer id", res.customerId === "cus_123", res.customerId);
}

// ------------------------------------------------ L5: createSubscription
{
  const { impl, calls } = fakeFetch(() => ({ json: { id: "sub_123", status: "trialing" } }));
  const provider = new LiveStripeProvider({ apiKey: "sk_test_key", fetchImpl: impl });
  const res = await provider.createSubscription({
    customerId: "cus_123",
    plan: "professional",
    businessId: "biz_1",
    trialDays: 14,
    paymentMethodId: "pm_card_visa",
  });
  const call = calls[0];
  const body = parseForm(call.body);
  pass("L5a createSubscription → POST /v1/subscriptions", call.method === "POST" && call.url === `${STRIPE_API_BASE_URL}/subscriptions`, `${call.method} ${call.url}`);
  pass(
    "L5b createSubscription sends the plan price, trial_period_days=14 and business metadata",
    body.customer === "cus_123" &&
      body["items[0][price]"] === "price_pro_env" &&
      body.trial_period_days === "14" &&
      body["metadata[businessId]"] === "biz_1",
    call.body
  );
  pass("L5c the payment method from checkout is attached as the default", body.default_payment_method === "pm_card_visa", call.body);
  pass("L5d createSubscription returns id + provider status", res.subscriptionId === "sub_123" && res.status === "trialing", JSON.stringify(res));
}
{
  const { impl, calls } = fakeFetch(() => ({ json: { id: "sub_456", status: "trialing" } }));
  const provider = new LiveStripeProvider({ apiKey: "sk_test_key", fetchImpl: impl, prices: { starter: "price_starter_arg" } });
  await provider.createSubscription({ customerId: "cus_1", plan: "starter", businessId: "b1" });
  const body = parseForm(calls[0].body);
  pass(
    "L5e constructor prices win and trial_period_days defaults to 14",
    body["items[0][price]"] === "price_starter_arg" && body.trial_period_days === "14" && !("default_payment_method" in body),
    calls[0].body
  );
}

// ------------------------------------------------ L6: cancelSubscription
{
  const { impl, calls } = fakeFetch(() => ({ json: { id: "sub_123", status: "canceled" } }));
  const provider = new LiveStripeProvider({ apiKey: "sk_test_key", fetchImpl: impl });
  const res = await provider.cancelSubscription("sub_123");
  pass("L6a cancelSubscription → DELETE /v1/subscriptions/{id}", calls[0].method === "DELETE" && calls[0].url === `${STRIPE_API_BASE_URL}/subscriptions/sub_123`, `${calls[0].method} ${calls[0].url}`);
  pass("L6b cancelSubscription returns ok", res.ok === true, JSON.stringify(res));
}

// ------------------------------------------------ L7: createCheckoutSession
{
  const { impl, calls } = fakeFetch(() => ({ json: { id: "cs_123", url: "https://checkout.stripe.com/c/pay/cs_123" } }));
  const provider = new LiveStripeProvider({ apiKey: "sk_test_key", fetchImpl: impl });
  const res = await provider.createCheckoutSession({
    businessId: "biz_1",
    plan: "starter",
    customerId: "cus_123",
    trialDays: 14,
    successUrl: "https://app.example.com/app?trial_session={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://app.example.com/app",
  });
  const call = calls[0];
  const body = parseForm(call.body);
  pass("L7a createCheckoutSession → POST /v1/checkout/sessions", call.method === "POST" && call.url === `${STRIPE_API_BASE_URL}/checkout/sessions`, `${call.method} ${call.url}`);
  pass(
    "L7b checkout is a 14-day subscription trial with the plan price",
    body.mode === "subscription" &&
      body["line_items[0][price]"] === "price_starter_env" &&
      body["line_items[0][quantity]"] === "1" &&
      body["subscription_data[trial_period_days]"] === "14",
    call.body
  );
  pass(
    "L7c checkout carries the success/cancel URLs, the customer and the business reference",
    body.success_url.includes("{CHECKOUT_SESSION_ID}") &&
      body.cancel_url === "https://app.example.com/app" &&
      body.customer === "cus_123" &&
      body.client_reference_id === "biz_1" &&
      body["metadata[businessId]"] === "biz_1",
    call.body
  );
  pass("L7d createCheckoutSession returns the url + session id", res.url.includes("checkout.stripe.com") && res.sessionId === "cs_123", JSON.stringify(res));
}

// ------------------------------------------------ L8: retrieveCheckoutSession
{
  const { impl, calls } = fakeFetch(() => ({
    json: {
      id: "cs_123",
      customer: "cus_123",
      subscription: { id: "sub_123", status: "trialing", trial_end: 1_790_000_000 },
      status: "complete",
    },
  }));
  const provider = new LiveStripeProvider({ apiKey: "sk_test_key", fetchImpl: impl });
  const details = await provider.retrieveCheckoutSession("cs_123");
  pass(
    "L8a retrieveCheckoutSession → GET the session with the subscription expanded",
    calls[0].method === "GET" && calls[0].url === `${STRIPE_API_BASE_URL}/checkout/sessions/cs_123?expand[]=subscription`,
    `${calls[0].method} ${calls[0].url}`
  );
  pass(
    "L8b session details map to customer/subscription/status/trialEndsAt",
    details.customerId === "cus_123" && details.subscriptionId === "sub_123" && details.status === "trialing" && details.trialEndsAt === 1_790_000_000_000,
    JSON.stringify(details)
  );
}
{
  const { impl } = fakeFetch(() => ({ json: { id: "cs_1", customer: "cus_1", subscription: "sub_1", status: "complete" } }));
  const provider = new LiveStripeProvider({ apiKey: "sk_test_key", fetchImpl: impl });
  const details = await provider.retrieveCheckoutSession("cs_1");
  pass(
    "L8c an unexpanded string subscription still resolves",
    details.subscriptionId === "sub_1" && details.customerId === "cus_1" && details.trialEndsAt === null,
    JSON.stringify(details)
  );
}
{
  const { impl } = fakeFetch(() => ({ json: { id: "cs_2", customer: null, subscription: null, status: "open" } }));
  const provider = new LiveStripeProvider({ apiKey: "sk_test_key", fetchImpl: impl });
  let msg = "";
  try {
    await provider.retrieveCheckoutSession("cs_2");
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  pass("L8d an incomplete session refuses to store ids", msg.includes("no customer/subscription"), msg.slice(0, 120));
}

// ------------------------------------------------ L9: API errors
{
  const { impl } = fakeFetch(() => ({ status: 402, text: '{"error":{"message":"Your card was declined."}}' }));
  const provider = new LiveStripeProvider({ apiKey: "sk_test_key", fetchImpl: impl });
  let err: unknown = null;
  try {
    await provider.createCustomer({ email: "a@b.com", name: "A", businessId: "b" });
  } catch (e) {
    err = e;
  }
  pass(
    "L9a a Stripe error surfaces as StripeApiError with the HTTP status + body",
    err instanceof StripeApiError && err.status === 402 && err.body.includes("declined"),
    err instanceof Error ? err.message.slice(0, 120) : String(err)
  );
}

// ------------------------------------------------ L10: mock contract unchanged
{
  const mock = new MockStripeProvider();
  const checkout = await mock.createCheckoutSession({ businessId: "biz_9", plan: "starter", successUrl: "https://x/s" });
  pass(
    "L10a mock checkout URL shape is unchanged (stub url + mock session id)",
    checkout.url.startsWith("/mock-checkout?businessId=biz_9&plan=starter") && (checkout.sessionId ?? "").startsWith("cs_mock_"),
    checkout.url
  );
  const details = await mock.retrieveCheckoutSession(checkout.sessionId!);
  pass(
    "L10b mock confirm ids are deterministic and clearly mock",
    details.customerId.startsWith("cus_mock_") && details.subscriptionId.startsWith("sub_mock_") && details.status === "trialing",
    JSON.stringify(details)
  );
  const sub = await mock.createSubscription({ customerId: "cus_mock_1", plan: "starter", businessId: "b", trialDays: 14 });
  pass("L10c mock createSubscription reports a trialing subscription", sub.status === "trialing" && sub.subscriptionId.startsWith("sub_mock_"), JSON.stringify(sub));
  pass("L10d mock name is mock-stripe (health check + integrations page)", mock.name === "mock-stripe", mock.name);
}

// ------------------------------------------------ L11: registry (child process)
{
  const entry = new URL("./src/server/integrations/index.ts", import.meta.url).pathname;
  const script = `
    (async () => {
      const { getStripeProvider } = await import(${JSON.stringify(entry)});
      const provider = getStripeProvider();
      console.log("NAME=" + provider.name);
      try {
        await provider.createCustomer({ email: "a@b.com", name: "A", businessId: "b" });
        console.log("ERR=none");
      } catch (e) {
        console.log("ERR=" + (/STRIPE_API_KEY/.test(e.message) ? "STRIPE_API_KEY" : e.message));
      }
    })();
  `;
  const child = Bun.spawnSync(["bun", "-e", script], {
    env: { ...process.env, STRIPE_PROVIDER: "live", STRIPE_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = child.stdout.toString();
  pass(
    "L11a STRIPE_PROVIDER=live resolves to the live provider and never falls back to the mock",
    out.includes("NAME=stripe-live") && out.includes("ERR=STRIPE_API_KEY"),
    out.trim().replace(/\n/g, " | ") || child.stderr.toString().slice(0, 200)
  );
  const child2 = Bun.spawnSync(["bun", "-e", script], {
    env: { ...process.env, STRIPE_PROVIDER: "", STRIPE_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out2 = child2.stdout.toString();
  pass(
    "L11b unset STRIPE_PROVIDER still resolves to the default mock provider",
    out2.includes("NAME=mock-stripe"),
    out2.trim().replace(/\n/g, " | ") || child2.stderr.toString().slice(0, 200)
  );
}

// ------------------------------------------------ env surface
pass(
  "L12a env exposes STRIPE_PRICE_* + STRIPE_PRICES_JSON (no price ids in source)",
  env.stripePriceStarter === "price_starter_env" && env.stripePricePremium === "price_premium_env",
  `${env.stripePriceStarter}/${env.stripePricePremium}`
);
pass("L12b env still reports the mock provider by default", env.stripeProvider === "mock", env.stripeProvider);

// cleanup env so a later suite in the same shell is unaffected
delete process.env.STRIPE_PRICE_STARTER;
delete process.env.STRIPE_PRICE_PROFESSIONAL;
delete process.env.STRIPE_PRICE_PREMIUM;
delete process.env.STRIPE_PRICES_JSON;

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
