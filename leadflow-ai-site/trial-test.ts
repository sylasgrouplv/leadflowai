/**
 * FREE-TRIAL acceptance test — the "14-day free trial" the marketing site has
 * always promised is now actually enforced (owner message 2026-09-23).
 *
 * Exercises:
 *   T1  createBusiness starts a real 14-day clock (plan starter, status
 *       trialing, currentPeriodEnd ≈ now + 14 days)
 *   T2  getTrialState is a pure clock: NULL end = active forever (demo/legacy),
 *       future end = active + daysLeft, exactly 14 days at the boundary, last
 *       3 days = expiringSoon, past end = expired, canceled = canceled, and a
 *       paid "active" subscription whose period lapsed is NOT expired
 *   T3  repo.cancelTrial flips status → canceled, is idempotent (second call is
 *       a no-op), clears nothing else, and never charges anyone
 *   T4  POST /api/business/cancel-trial: authenticated, 200, audits once,
 *       idempotent on the second call
 *   T5  GET /api/auth/me carries currentPeriodEnd + trialState (backward
 *       compatible: plan + status still there) for trialing, canceled and
 *       expired accounts
 *   T6  a NULL clock (demo tenant / legacy rows) is never expired or canceled,
 *       and the seed clears the demo tenant's clock
 *   T7  tenant isolation: canceling one business's trial never touches another's
 *
 * Style: matches onboarding-test.ts / reminder-test.ts (in-process suite) —
 * repo functions + the Hono app in-process, local SQLite, tenant-scoped cleanup.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run trial-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "./src/server/index";
import { createSession } from "./src/server/auth/session";
import { hashPassword } from "./src/server/auth/password";

runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();
const DAY = 86_400_000;
/** Fixed reference instant so the pure-clock cases are deterministic. */
const T0 = Date.UTC(2026, 8, 23, 12, 0, 0);

/** Same tenant-scoped cleanup as onboarding-test / reminder-test (FK-safe). */
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

(async () => {
  console.log("=== Free trial: 14 days, enforced ===");
  const app = await createApp();
  const stamp = Date.now();

  // --------------------------------------------------------- T1: the clock
  const ownerEmail = `trial-owner-${stamp}@test.local`;
  const owner = await repo.createUser({ name: "Trial Owner", email: ownerEmail, passwordHash: hashPassword("trialpass1"), role: "owner" });
  const beforeCreate = Date.now();
  const business = (await repo.createBusiness({ ownerId: owner.id, name: "Trial Test Co", category: "hvac" }))!;
  const afterCreate = Date.now();
  const sub = await repo.getSubscription(business.id);
  pass(
    "T1a createBusiness creates a trialing starter subscription",
    !!sub && sub.plan === "starter" && sub.status === "trialing",
    `plan=${sub?.plan} status=${sub?.status}`
  );
  pass(
    "T1b createBusiness sets currentPeriodEnd = creation time + 14 days",
    !!sub && sub.currentPeriodEnd !== null &&
      sub.currentPeriodEnd >= beforeCreate + repo.TRIAL_MS &&
      sub.currentPeriodEnd <= afterCreate + repo.TRIAL_MS,
    `end=${sub?.currentPeriodEnd} expected≈${beforeCreate + repo.TRIAL_MS}`
  );
  pass("T1c TRIAL_DAYS is 14", repo.TRIAL_DAYS === 14, `TRIAL_DAYS=${repo.TRIAL_DAYS}`);

  // --------------------------------------------------- T2: pure trial clock
  const clock = (status: string, end: number | null) => repo.getTrialState({ status, currentPeriodEnd: end }, T0);

  const forever = clock("trialing", null);
  pass(
    "T2a null currentPeriodEnd = active forever (never expires, no countdown)",
    forever.state === "active" && forever.daysLeft === null && forever.trialEndsAt === null,
    JSON.stringify(forever)
  );

  const midway = clock("trialing", T0 + 10 * DAY);
  pass(
    "T2b future end = active with daysLeft",
    midway.state === "active" && midway.daysLeft === 10 && midway.trialEndsAt === T0 + 10 * DAY,
    JSON.stringify(midway)
  );

  const boundary = clock("trialing", T0 + 14 * DAY);
  pass(
    "T2c boundary at exactly 14 days = active, daysLeft 14",
    boundary.state === "active" && boundary.daysLeft === 14,
    JSON.stringify(boundary)
  );

  const lastDays = clock("trialing", T0 + 2 * DAY);
  const stillActive = clock("trialing", T0 + 5 * DAY);
  pass(
    "T2d last 3 days = expiringSoon, earlier still active",
    lastDays.state === "expiringSoon" && lastDays.daysLeft === 2 && stillActive.state === "active",
    `${JSON.stringify(lastDays)} / ${JSON.stringify(stillActive)}`
  );

  const overdue = clock("trialing", T0 - 1000);
  pass("T2e past end (trialing) = expired, daysLeft clamped at 0", overdue.state === "expired" && overdue.daysLeft === 0, JSON.stringify(overdue));

  const canceled = clock("canceled", T0 + 5 * DAY);
  pass("T2f status canceled = canceled", canceled.state === "canceled" && canceled.trialEndsAt === T0 + 5 * DAY, JSON.stringify(canceled));

  const canceledNoClock = clock("canceled", null);
  pass("T2g canceled with no clock = canceled (still no expiry maths)", canceledNoClock.state === "canceled" && canceledNoClock.daysLeft === null, JSON.stringify(canceledNoClock));

  const lapsedPaid = clock("active", T0 - 5 * DAY);
  pass("T2h paid 'active' subscription with a lapsed period is NOT expired", lapsedPaid.state !== "expired", JSON.stringify(lapsedPaid));

  const noSub = repo.getTrialState(null, T0);
  pass("T2i missing subscription = active, no clock", noSub.state === "active" && noSub.trialEndsAt === null, JSON.stringify(noSub));

  // ----------------------------------------------- T5a: /me before cancel
  const session = await createSession(owner.id);
  const cookie = `lf_session=${session.token}`;
  let me = await (await app.request("/api/auth/me", { headers: { cookie } })).json() as {
    subscription: { plan: string; status: string; currentPeriodEnd: number | null; trialState: repo.TrialState } | null;
  };
  pass(
    "T5a /api/auth/me keeps plan + status and adds currentPeriodEnd + trialState",
    !!me.subscription && me.subscription.plan === "starter" && me.subscription.status === "trialing" &&
      me.subscription.currentPeriodEnd !== null && me.subscription.trialState.state === "active" &&
      me.subscription.trialState.daysLeft === 14 && me.subscription.trialState.trialEndsAt === me.subscription.currentPeriodEnd,
    JSON.stringify(me.subscription)
  );

  // ------------------------------------------- T4: cancel-trial endpoint
  const cancelRes = await app.request("/api/business/cancel-trial", { method: "POST", headers: { cookie } });
  const cancelBody = await cancelRes.json() as { subscription: { status: string; plan: string; currentPeriodEnd: number | null; trialState: repo.TrialState } };
  pass(
    "T4a POST /api/business/cancel-trial -> 200 + canceled subscription",
    cancelRes.status === 200 && cancelBody.subscription.status === "canceled" && cancelBody.subscription.trialState.state === "canceled",
    `status=${cancelRes.status} ${JSON.stringify(cancelBody.subscription)}`
  );
  pass(
    "T4b cancellation keeps the plan + clock for the audit trail",
    cancelBody.subscription.plan === "starter" && cancelBody.subscription.currentPeriodEnd === sub!.currentPeriodEnd,
    JSON.stringify(cancelBody.subscription)
  );
  const cancelRes2 = await app.request("/api/business/cancel-trial", { method: "POST", headers: { cookie } });
  const cancelBody2 = await cancelRes2.json() as { subscription: { status: string } };
  pass("T4c second cancel-trial call is idempotent (200, still canceled)", cancelRes2.status === 200 && cancelBody2.subscription.status === "canceled", `status=${cancelRes2.status}`);
  const auditRows = await db.select().from(s.auditLogs).where(eq(s.auditLogs.businessId, business.id)).execute();
  const cancelAudits = auditRows.filter((r) => r.action === "subscription.cancel_trial");
  pass("T4d cancel-trial audits once, not twice", cancelAudits.length === 1, `rows=${cancelAudits.length}`);
  pass("T4e the audit trail records that nobody was charged", cancelAudits[0]?.detailsJson?.includes('"charged":false') === true, cancelAudits[0]?.detailsJson ?? "");

  // ------------------------------------------ T5b: /me after cancellation
  me = await (await app.request("/api/auth/me", { headers: { cookie } })).json();
  pass(
    "T5b /api/auth/me reports the canceled trial",
    me.subscription?.status === "canceled" && me.subscription.trialState.state === "canceled" && me.subscription.currentPeriodEnd !== null,
    JSON.stringify(me.subscription)
  );

  // ------------------------------- T7: tenant isolation for the cancel path
  const otherEmail = `trial-other-${stamp}@test.local`;
  const other = await repo.createUser({ name: "Other Owner", email: otherEmail, passwordHash: hashPassword("trialpass2"), role: "owner" });
  const otherBiz = (await repo.createBusiness({ ownerId: other.id, name: "Untouched Co" }))!;
  await app.request("/api/business/cancel-trial", { method: "POST", headers: { cookie } });
  const otherSub = await repo.getSubscription(otherBiz.id);
  pass("T7a canceling one tenant's trial leaves other tenants trialing", otherSub?.status === "trialing", `other=${otherSub?.status}`);
  const ghostRes = await app.request("/api/business/cancel-trial", { method: "POST" });
  pass("T7b cancel-trial without a session is rejected", ghostRes.status === 401 || ghostRes.status === 403, `status=${ghostRes.status}`);

  // --------------------------- T5c/T6: expired account + NULL clock (demo)
  await db.update(s.subscriptions).set({ currentPeriodEnd: Date.now() - DAY }).where(eq(s.subscriptions.businessId, otherBiz.id)).execute();
  const otherSession = await createSession(other.id);
  const otherMe = await (await app.request("/api/auth/me", { headers: { cookie: `lf_session=${otherSession.token}` } })).json() as {
    subscription: { status: string; currentPeriodEnd: number | null; trialState: repo.TrialState } | null;
  };
  pass(
    "T5c /api/auth/me reports an expired trial (drives the trial-ended screen)",
    otherMe.subscription?.trialState.state === "expired" && otherMe.subscription.trialState.daysLeft === 0,
    JSON.stringify(otherMe.subscription)
  );

  await repo.clearSubscriptionPeriodEnd(otherBiz.id);
  const otherMe2 = await (await app.request("/api/auth/me", { headers: { cookie: `lf_session=${otherSession.token}` } })).json() as {
    subscription: { status: string; currentPeriodEnd: number | null; trialState: repo.TrialState } | null;
  };
  pass(
    "T6a NULL clock (demo/legacy account) is active forever — never blocked",
    otherMe2.subscription?.currentPeriodEnd === null && otherMe2.subscription.trialState.state === "active" &&
      otherMe2.subscription.trialState.daysLeft === null && otherMe2.subscription.status === "trialing",
    JSON.stringify(otherMe2.subscription)
  );
  const demoEmail = "demo@leadflow.ai";
  const demoUser = await repo.getUserByEmail(demoEmail);
  const demoBiz = demoUser ? await repo.getBusinessForUser(demoUser.id) : null;
  const demoSub = demoBiz ? await repo.getSubscription(demoBiz.id) : null;
  pass(
    "T6b the seeded Smith's HVAC demo tenant is never expired/canceled",
    !demoSub || repo.getTrialState(demoSub).state === "active",
    demoSub ? JSON.stringify(repo.getTrialState(demoSub)) : "demo tenant not seeded locally (skipped)"
  );
  const seedSrc = await Bun.file("src/server/db/seed.ts").text();
  pass(
    "T6c seed clears the demo tenant's trial clock (permanent demo)",
    seedSrc.includes("clearSubscriptionPeriodEnd(business.id)"),
    seedSrc.includes("clearSubscriptionPeriodEnd(business.id)") ? "found" : "MISSING"
  );

  // ------------------------------------------------------------ cleanup
  await wipeBusiness(business.id);
  await wipeBusiness(otherBiz.id);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("trial-test crashed:", err);
  process.exit(1);
});
