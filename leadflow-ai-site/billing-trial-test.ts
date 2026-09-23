/**
 * Card-gated 14-day trial — endpoint + copy tests (BUILD 2).
 *
 * In-process suite (Hono app + local SQLite, the mock Stripe provider): no
 * network, no Stripe keys, no live charge path. Covers
 *
 *   B1  GET /api/billing/config reports the billing mode (mock by default),
 *   B2  POST /api/billing/trial-checkout returns a checkout URL, stores the
 *       customer, and reuses it on a retry (no duplicate customer),
 *   B3  POST /api/billing/trial-confirm stores stripeCustomerId +
 *       stripeSubscriptionId and /api/auth/me reports cardOnFile,
 *   B4  bad/incomplete confirm input is rejected (400),
 *   B5  auth + tenancy: no session → 401/403, no business → 404, and one
 *       tenant's checkout/confirm never touches another tenant's row,
 *   B6  POST /api/business/cancel-trial cancels the Stripe subscription when
 *       the row has one (spy), records charged:false + stripeCanceled, and
 *       stays idempotent (one audit row, one provider call),
 *   B7  the copy sweep: no "no credit card required" / "never took a card"
 *       claim survives anywhere in src/client, the trial line and signup
 *       subtitle say card required, the FAQ setup fee is the flat $1,500, and
 *       the owner's landing-page offer copy is untouched.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run billing-trial-test.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "./src/server/index";
import { createSession } from "./src/server/auth/session";
import { hashPassword } from "./src/server/auth/password";
import { getStripeProvider } from "./src/server/integrations";

runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();

/** Same tenant-scoped, FK-safe cleanup as trial-test.ts / onboarding-test.ts. */
async function wipeBusiness(id: string) {
  for (const lead of await db.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.businessId, id)).execute()) {
    for (const a of await db.select().from(s.appointments).where(eq(s.appointments.leadId, lead.id)).execute()) await db.delete(s.appointments).where(eq(s.appointments.id, a.id)).execute();
    await db.delete(s.followUps).where(eq(s.followUps.leadId, lead.id)).execute();
    for (const c of await db.select().from(s.conversations).where(eq(s.conversations.leadId, lead.id)).execute()) {
      await db.delete(s.messages).where(eq(s.messages.conversationId, c.id)).execute();
      await db.delete(s.conversations).where(eq(s.conversations.id, c.id)).execute();
    }
    await db.delete(s.agentActions).where(eq(s.agentActions.leadId, lead.id)).execute();
    await db.delete(s.reviews).where(eq(s.reviews.leadId, lead.id)).execute();
    await db.delete(s.leads).where(eq(s.leads.id, lead.id)).execute();
  }
  await db.delete(s.humanTasks).where(eq(s.humanTasks.businessId, id)).execute();
  await db.delete(s.events).where(eq(s.events.businessId, id)).execute();
  await db.delete(s.automationRuns).where(eq(s.automationRuns.businessId, id)).execute();
  await db.delete(s.automationRules).where(eq(s.automationRules.businessId, id)).execute();
  await db.delete(s.reviewConfigs).where(eq(s.reviewConfigs.businessId, id)).execute();
  await db.delete(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, id)).execute();
  await db.delete(s.notifications).where(eq(s.notifications.businessId, id)).execute();
  await db.delete(s.usageEvents).where(eq(s.usageEvents.businessId, id)).execute();
  await db.delete(s.auditLogs).where(eq(s.auditLogs.businessId, id)).execute();
  await db.delete(s.widgetSettings).where(eq(s.widgetSettings.businessId, id)).execute();
  await db.delete(s.integrations).where(eq(s.integrations.businessId, id)).execute();
  await db.delete(s.subscriptions).where(eq(s.subscriptions.businessId, id)).execute();
  await db.delete(s.services).where(eq(s.services.businessId, id)).execute();
  await db.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, id)).execute();
  const members = await db.select({ userId: s.teamMembers.userId }).from(s.teamMembers).where(eq(s.teamMembers.businessId, id)).execute();
  await db.delete(s.teamMembers).where(eq(s.teamMembers.businessId, id)).execute();
  await db.delete(s.businesses).where(eq(s.businesses.id, id)).execute();
  for (const m of members) {
    await db.delete(s.sessions).where(eq(s.sessions.userId, m.userId)).execute();
    await db.delete(s.users).where(eq(s.users.id, m.userId)).execute();
  }
}

async function makeOwner(tag: string) {
  const stamp = Date.now();
  const user = await repo.createUser({
    name: `Card Owner ${tag}`,
    email: `card-${tag}-${stamp}@test.local`,
    passwordHash: hashPassword("cardpass123"),
    role: "owner",
  });
  const business = (await repo.createBusiness({ ownerId: user.id, name: `Card Test ${tag}`, category: "hvac", email: `biz-${tag}@test.local` }))!;
  const session = await createSession(user.id);
  return { user, business, cookie: `lf_session=${session.token}` };
}

(async () => {
  console.log("=== Card-gated 14-day trial (mock provider) ===");
  const app = await createApp();
  const a = await makeOwner("a");
  const b = await makeOwner("b");

  // ------------------------------------------------- B1: billing config
  const configRes = await app.request("/api/billing/config", { headers: { cookie: a.cookie } });
  const config = (await configRes.json()) as {
    provider: string;
    live: boolean;
    cardRequired: boolean;
    trialDays: number;
    pricesConfigured: boolean;
  };
  pass(
    "B1a GET /api/billing/config reports the mock provider + 14-day trial",
    configRes.status === 200 && config.provider === "mock" && config.live === false && config.trialDays === 14 && config.trialDays === repo.TRIAL_DAYS,
    JSON.stringify(config)
  );
  pass("B1b cardRequired is false with the mock (no Stripe keys configured)", config.cardRequired === false, JSON.stringify(config));
  const configAnon = await app.request("/api/billing/config");
  pass("B1c /api/billing/config requires a session", configAnon.status === 401 || configAnon.status === 403, `status=${configAnon.status}`);

  // ------------------------------------------------- B2: trial checkout
  const checkoutRes = await app.request("/api/billing/trial-checkout", { method: "POST", headers: { cookie: a.cookie } });
  const checkout = (await checkoutRes.json()) as { url: string; sessionId: string; provider: string };
  pass(
    "B2a POST /api/billing/trial-checkout returns a checkout url + session id (mock)",
    checkoutRes.status === 200 && checkout.url.startsWith("/mock-checkout?") && checkout.sessionId.startsWith("cs_mock_"),
    JSON.stringify(checkout)
  );
  pass("B2b the checkout url carries the business + plan it was created for", checkout.url.includes(`businessId=${a.business.id}`) && checkout.url.includes("plan=starter"), checkout.url);
  const afterCheckout = await repo.getSubscription(a.business.id);
  pass(
    "B2c the provider customer is stored on the subscription row",
    !!afterCheckout?.stripeCustomerId && afterCheckout.stripeCustomerId.startsWith("cus_mock_"),
    afterCheckout?.stripeCustomerId ?? "none"
  );
  pass("B2d no subscription id is stored before checkout completes", !afterCheckout?.stripeSubscriptionId, afterCheckout?.stripeSubscriptionId ?? "none");
  const checkoutRes2 = await app.request("/api/billing/trial-checkout", { method: "POST", headers: { cookie: a.cookie } });
  const checkout2 = (await checkoutRes2.json()) as { sessionId: string };
  const afterCheckout2 = await repo.getSubscription(a.business.id);
  pass(
    "B2e a retry reuses the same customer (no duplicate Stripe customer)",
    afterCheckout2?.stripeCustomerId === afterCheckout?.stripeCustomerId && checkout2.sessionId !== checkout.sessionId,
    `${afterCheckout2?.stripeCustomerId}`
  );

  // ------------------------------------------------- B3: trial confirm
  const beforeConfirmEnd = (await repo.getSubscription(a.business.id))?.currentPeriodEnd ?? null;
  const confirmRes = await app.request("/api/billing/trial-confirm", {
    method: "POST",
    headers: { cookie: a.cookie, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: checkout.sessionId }),
  });
  const confirmBody = (await confirmRes.json()) as { subscription: { cardOnFile: boolean; status: string; plan: string } };
  const rowA = await repo.getSubscription(a.business.id);
  const seed = checkout.sessionId.replace(/^cs_mock_/, "");
  pass(
    "B3a POST /api/billing/trial-confirm stores the customer + subscription ids",
    confirmRes.status === 200 && rowA?.stripeSubscriptionId === `sub_mock_${seed}` && rowA?.stripeCustomerId === `cus_mock_${seed}`,
    `${rowA?.stripeCustomerId} / ${rowA?.stripeSubscriptionId}`
  );
  pass("B3b confirm reports the card on file and keeps the trial running", confirmBody.subscription?.cardOnFile === true && rowA?.status === "trialing" && rowA?.plan === "starter", JSON.stringify(confirmBody));
  pass(
    "B3c the local trial clock is untouched by confirm (Stripe owns the charge)",
    rowA?.currentPeriodEnd === beforeConfirmEnd && beforeConfirmEnd !== null,
    `${rowA?.currentPeriodEnd} vs ${beforeConfirmEnd}`
  );
  const me = (await (await app.request("/api/auth/me", { headers: { cookie: a.cookie } })).json()) as {
    subscription: { cardOnFile: boolean } | null;
    billing: { provider: string; trialDays: number } | null;
  };
  pass(
    "B3d GET /api/auth/me exposes cardOnFile + the billing mode (drives the card step)",
    me.subscription?.cardOnFile === true && me.billing?.provider === "mock" && me.billing?.live === false && me.billing?.trialDays === 14,
    JSON.stringify(me.billing)
  );

  // ------------------------------------------------- B4: bad confirm input
  const noSession = await app.request("/api/billing/trial-confirm", {
    method: "POST",
    headers: { cookie: a.cookie, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  pass("B4a confirm without a session id is rejected (400)", noSession.status === 400, `status=${noSession.status}`);
  const shortSession = await app.request("/api/billing/trial-confirm", {
    method: "POST",
    headers: { cookie: a.cookie, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "x" }),
  });
  pass("B4b confirm with a nonsense session id is rejected (400)", shortSession.status === 400, `status=${shortSession.status}`);

  // ------------------------------------------------- B5: auth + isolation
  const anonCheckout = await app.request("/api/billing/trial-checkout", { method: "POST" });
  pass("B5a trial-checkout without a session is rejected", anonCheckout.status === 401 || anonCheckout.status === 403, `status=${anonCheckout.status}`);
  const anonConfirm = await app.request("/api/billing/trial-confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "cs_mock_whatever" }),
  });
  pass("B5b trial-confirm without a session is rejected", anonConfirm.status === 401 || anonConfirm.status === 403, `status=${anonConfirm.status}`);
  const orphan = await repo.createUser({
    name: "No Business",
    email: `card-orphan-${Date.now()}@test.local`,
    passwordHash: hashPassword("cardpass123"),
    role: "owner",
  });
  const orphanSession = await createSession(orphan.id);
  const orphanRes = await app.request("/api/billing/trial-checkout", { method: "POST", headers: { cookie: `lf_session=${orphanSession.token}` } });
  pass("B5c trial-checkout without a business is 404", orphanRes.status === 404, `status=${orphanRes.status}`);
  const rowB = await repo.getSubscription(b.business.id);
  pass(
    "B5d another tenant's subscription row is untouched by checkout/confirm",
    !rowB?.stripeCustomerId && !rowB?.stripeSubscriptionId,
    `${rowB?.stripeCustomerId}/${rowB?.stripeSubscriptionId}`
  );
  await db.delete(s.sessions).where(eq(s.sessions.userId, orphan.id)).execute();
  await db.delete(s.users).where(eq(s.users.id, orphan.id)).execute();

  // ------------------------------------------------- B6: cancel cancels Stripe
  const provider = getStripeProvider() as unknown as { cancelSubscription: (id: string) => Promise<{ ok: true }> };
  const originalCancel = provider.cancelSubscription.bind(provider);
  const canceled: string[] = [];
  provider.cancelSubscription = async (id: string) => {
    canceled.push(id);
    return { ok: true as const };
  };
  try {
    const cancelRes = await app.request("/api/business/cancel-trial", { method: "POST", headers: { cookie: a.cookie } });
    const canceledSub = await repo.getSubscription(a.business.id);
    pass("B6a cancel-trial still flips the local subscription to canceled", cancelRes.status === 200 && canceledSub?.status === "canceled", `status=${cancelRes.status}/${canceledSub?.status}`);
    pass(
      "B6b cancel-trial cancels the Stripe subscription when the row has one",
      canceled.length === 1 && canceled[0] === `sub_mock_${seed}`,
      JSON.stringify(canceled)
    );
    const audits = (await db.select().from(s.auditLogs).where(eq(s.auditLogs.businessId, a.business.id)).execute()).filter(
      (r) => r.action === "subscription.cancel_trial"
    );
    pass(
      "B6c the audit row keeps charged:false and records the Stripe cancel",
      audits.length === 1 && audits[0].detailsJson.includes('"charged":false') && audits[0].detailsJson.includes('"stripeCanceled":true'),
      audits[0]?.detailsJson ?? "none"
    );
    const cancelAgain = await app.request("/api/business/cancel-trial", { method: "POST", headers: { cookie: a.cookie } });
    const auditsAgain = (await db.select().from(s.auditLogs).where(eq(s.auditLogs.businessId, a.business.id)).execute()).filter(
      (r) => r.action === "subscription.cancel_trial"
    );
    pass(
      "B6d cancel-trial stays idempotent (no second audit row)",
      cancelAgain.status === 200 && auditsAgain.length === 1,
      `audits=${auditsAgain.length}`
    );
    const checkoutAudits = (await db.select().from(s.auditLogs).where(eq(s.auditLogs.businessId, a.business.id)).execute()).filter(
      (r) => r.action === "subscription.trial_checkout" || r.action === "subscription.trial_confirm"
    );
    pass(
      "B6e the trial card step is audited as never charged",
      checkoutAudits.length === 3 && checkoutAudits.every((r) => r.detailsJson.includes('"charged":false')),
      `rows=${checkoutAudits.length}`
    );
  } finally {
    provider.cancelSubscription = originalCancel;
  }

  // ------------------------------------------------- B7: copy sweep
  const clientFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) clientFiles.push(full);
    }
  };
  walk("src/client");
  const clientSource = clientFiles.map((f) => `${f}\n${readFileSync(f, "utf8")}`).join("\n");
  const banned = ["no credit card required", "no credit card needed", "no credit card", "never took a card", "$1,500–$3,000", "$1,500-$3,000"];
  for (const phrase of banned) {
    const hit = clientSource.toLowerCase().includes(phrase.toLowerCase());
    pass(`B7 · "${phrase}" is gone from src/client`, !hit, hit ? "STILL PRESENT" : `checked ${clientFiles.length} files`);
  }
  const trustLine = readFileSync("src/client/content.ts", "utf8");
  pass(
    "B7 · TRUST_LINE says the card is required to start",
    trustLine.includes("Card required to start") && trustLine.includes("never charged"),
    trustLine.match(/export const TRUST_LINE[\s\S]{0,160}/)?.[0]?.replace(/\n/g, " ") ?? ""
  );
  const authSrc = readFileSync("src/client/pages/Auth.tsx", "utf8");
  pass(
    "B7 · the signup subtitle asks for the card honestly",
    authSrc.includes("We ask for your card to start it") && authSrc.includes("$0 charged today"),
    ""
  );
  const faq = readFileSync("src/client/content.ts", "utf8");
  pass(
    "B7 · the FAQ setup fee is the flat $1,500 sellable-catalog price",
    faq.includes("one-time setup fee of $1,500.") && faq.includes("$497, $997, or $1,497 per month"),
    faq.match(/Plans are \$497[\s\S]{0,120}/)?.[0]?.replace(/\n/g, " ") ?? ""
  );
  const landing = readFileSync("src/client/pages/Landing.tsx", "utf8");
  pass(
    "B7 · the owner's landing hero offer copy is unchanged",
    landing.includes("Try our service free for 14 days — If you don't like it, cancel before the trial ends."),
    ""
  );
  const trialCard = readFileSync("src/client/pages/TrialCard.tsx", "utf8");
  const trialCardFlat = trialCard.replace(/\s+/g, " ");
  pass(
    "B7 · the card step carries the required card-required sentence",
    trialCardFlat.includes(
      "Enter your card to start the 14-day free trial — $0 charged today, cancel before the trial ends and you're never charged."
    ),
    ""
  );
  const appShell = readFileSync("src/client/pages/AppShell.tsx", "utf8");
  pass(
    "B7 · the trial-ended screen tells the card-on-file truth (no card-free claim)",
    appShell.includes("you were never charged") && appShell.includes("No card was on file for this account"),
    ""
  );
  pass(
    "B7 · the app shell blocks a running trial until a card is on file",
    appShell.includes("subscription?.cardOnFile !== true") && appShell.includes("<TrialCardStep"),
    ""
  );

  // ------------------------------------------------- cleanup
  await wipeBusiness(a.business.id);
  await wipeBusiness(b.business.id);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("billing-trial-test crashed:", err);
  process.exit(1);
});
