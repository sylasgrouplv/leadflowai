/**
 * DOGFOODING PHASE 0 (Chunk A) acceptance test — LeadFlow AI as a tenant.
 *
 * Exercises:
 *   A) seed-dogfood: tenant exists (business "LeadFlow AI", owner user, 3
 *      services, >=3 KB entries, 6 mock integrations, 4-step follow-up config,
 *      review config, widget settings) AND the tenant's default automation
 *      rules are present (created explicitly by the seed — NOT just lazily).
 *   B) seed-dogfood idempotency: a second run skips and never duplicates rows.
 *   C) POST /api/admin/businesses (admin tenant provisioning):
 *        401 unauthenticated, 403 non-admin, 400 invalid payload,
 *        409 duplicate owner email,
 *        201 creates business + owner + services + KB + default rules, and
 *        returns the temporary password (generated when not supplied).
 *
 * Style: matches the in-process suites (brain-test / auto-test / tools-test) —
 * repo functions + the Hono app in-process (createApp().request()), local
 * SQLite, tenant-scoped cleanup. The dogfood tenant itself is left in place
 * (it is the deliverable); only test-created rows are removed.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run dogfood-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "./src/server/index";
import { createSession } from "./src/server/auth/session";
import { hashPassword } from "./src/server/auth/password";
import { seedDogfood, DOGFOOD_OWNER_EMAIL, DOGFOOD_BUSINESS_NAME, DOGFOOD_FOLLOWUP_STEPS } from "./scripts/seed-dogfood";

runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}

const db = getDb();

/** Delete every row a test business owns (tenant-scoped), FK-safe. */
async function wipeBusiness(id: string) {
  const bizId = id;
  for (const lead of await db.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.businessId, bizId)).execute()) {
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
  await db.delete(s.humanTasks).where(eq(s.humanTasks.businessId, bizId)).execute();
  await db.delete(s.events).where(eq(s.events.businessId, bizId)).execute();
  await db.delete(s.automationRuns).where(eq(s.automationRuns.businessId, bizId)).execute();
  await db.delete(s.automationRules).where(eq(s.automationRules.businessId, bizId)).execute();
  await db.delete(s.reviewConfigs).where(eq(s.reviewConfigs.businessId, bizId)).execute();
  await db.delete(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, bizId)).execute();
  await db.delete(s.notifications).where(eq(s.notifications.businessId, bizId)).execute();
  await db.delete(s.usageEvents).where(eq(s.usageEvents.businessId, bizId)).execute();
  await db.delete(s.auditLogs).where(eq(s.auditLogs.businessId, bizId)).execute();
  await db.delete(s.widgetSettings).where(eq(s.widgetSettings.businessId, bizId)).execute();
  await db.delete(s.integrations).where(eq(s.integrations.businessId, bizId)).execute();
  await db.delete(s.subscriptions).where(eq(s.subscriptions.businessId, bizId)).execute();
  await db.delete(s.services).where(eq(s.services.businessId, bizId)).execute();
  await db.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, bizId)).execute();
  const members = await db.select({ userId: s.teamMembers.userId }).from(s.teamMembers).where(eq(s.teamMembers.businessId, bizId)).execute();
  await db.delete(s.teamMembers).where(eq(s.teamMembers.businessId, bizId)).execute();
  await db.delete(s.businesses).where(eq(s.businesses.id, bizId)).execute();
  for (const m of members) {
    await db.delete(s.sessions).where(eq(s.sessions.userId, m.userId)).execute();
    await db.delete(s.users).where(eq(s.users.id, m.userId)).execute();
  }
}

(async () => {
  // ------------------------------------------------------------ A) seed tenant
  const business = await seedDogfood();
  if (!business) throw new Error("seedDogfood returned no business");
  const bizId = business.id;
  pass("A1 business 'LeadFlow AI' created", business.name === DOGFOOD_BUSINESS_NAME, business.name);
  pass("A2 owner user exists", !!(await repo.getUserByEmail(DOGFOOD_OWNER_EMAIL)), DOGFOOD_OWNER_EMAIL);
  const owner = await repo.getUserByEmail(DOGFOOD_OWNER_EMAIL);
  pass("A3 owner is role=owner", owner?.role === "owner", owner?.role ?? "none");
  pass("A4 onboarding complete", business.onboardingCompleted === 1 && business.onboardingStep === 6, `step=${business.onboardingStep} completed=${business.onboardingCompleted}`);
  const services = await repo.listServices(bizId);
  pass("A5 three services", services.length === 3, `n=${services.length}`);
  const kb = await repo.listKnowledge(bizId);
  pass("A6 KB entries (>=3)", kb.length >= 3, `n=${kb.length}`);
  pass("A7 KB contains real pricing", kb.some((k) => k.answer.includes("$497") && k.answer.includes("$1,497") && k.answer.includes("$1,500")), "pricing entry present");
  const widget = await repo.getWidgetSettings(bizId);
  pass("A8 widget enabled", widget.enabled === 1 && widget.position === "bottom-right", `enabled=${widget.enabled}`);
  const integrations = await repo.listIntegrations(bizId);
  pass("A9 six mock integrations", integrations.length === 6 && integrations.every((i) => i.status === "mock"), integrations.map((i) => `${i.provider}=${i.status}`).join(","));
  const fuConfig = await repo.getFollowUpConfig(bizId);
  pass("A10 follow-up cadence 1/3/7/14", fuConfig.length === 4 && fuConfig.map((st) => st.days).join(",") === "1,3,7,14", fuConfig.map((st) => `${st.days}d:${st.type}`).join(","));
  const review = await repo.getReviewConfig(bizId);
  pass("A11 review config delay 3 + empty URL", review.delayDays === 3 && review.reviewUrl === "", `delay=${review.delayDays} url="${review.reviewUrl}"`);
  // Rules — the seed must create them explicitly (lazy path only runs on ticks).
  const rules = await repo.listAutomationRules(bizId);
  const ruleNames = rules.map((r) => r.name).sort();
  pass("A12 default automation rules present", ruleNames.join(",") === "appointment_confirmation,appointment_reminder,invoice_reminder,job_completed_review,lead_created_welcome,onboarding_reminders,qualified_followup_sequence,support_ticket_categorization", ruleNames.join(","));
  const reviewRule = rules.find((r) => r.name === "job_completed_review");
  pass("A13 review rule delay synced to config (3d)", reviewRule?.delayMs === 3 * 24 * 60 * 60 * 1000, `delayMs=${reviewRule?.delayMs}`);

  // -------------------------------------------------- B) idempotency (re-run)
  const again = await seedDogfood();
  pass("B1 re-run returns same business", again?.id === bizId, `first=${bizId} second=${again?.id}`);
  pass("B2 re-run did not duplicate services", (await repo.listServices(bizId)).length === 3, `n=${(await repo.listServices(bizId)).length}`);
  pass("B3 re-run did not duplicate rules", (await repo.listAutomationRules(bizId)).length === 8, `n=${(await repo.listAutomationRules(bizId)).length}`);

  // ------------------------------------------------- C) admin tenant provisioning
  const app = await createApp();
  // Seeded platform admin (same contract as brain5b: admin@leadflow.ai never deleted).
  let admin = await repo.getUserByEmail("admin@leadflow.ai");
  if (!admin) {
    admin = await repo.createUser({ name: "LeadFlow Admin", email: "admin@leadflow.ai", passwordHash: hashPassword("admin1234"), role: "admin" });
  }
  const adminSession = await createSession(admin.id);
  const adminCookie = `lf_session=${adminSession.token}`;

  // C1: unauthenticated -> 401.
  let r = await app.request("/api/admin/businesses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ businessName: "X", ownerEmail: "x@test.local", ownerName: "X" }) });
  pass("C1 admin route requires auth", r.status === 401, `status=${r.status}`);

  // C2: non-admin (owner role) -> 403.
  const nonAdmin = await repo.createUser({ name: "Dogfood NonAdmin", email: "dogfood-nonadmin@test.local", passwordHash: hashPassword("dogfood1234"), role: "owner" });
  const nonAdminSession = await createSession(nonAdmin.id);
  r = await app.request("/api/admin/businesses", { method: "POST", headers: { "content-type": "application/json", cookie: `lf_session=${nonAdminSession.token}` }, body: JSON.stringify({ businessName: "X", ownerEmail: "x@test.local", ownerName: "X" }) });
  pass("C2 non-admin -> 403", r.status === 403, `status=${r.status}`);

  // C3: invalid payload -> 400.
  r = await app.request("/api/admin/businesses", { method: "POST", headers: { "content-type": "application/json", cookie: adminCookie }, body: JSON.stringify({ businessName: "", ownerEmail: "not-an-email", ownerName: "" }) });
  pass("C3 invalid payload -> 400", r.status === 400, `status=${r.status}`);

  // C4: full provisioning -> 201 + persisted rows + rules.
  const TEST_EMAIL = "dogfood-admin-created@test.local";
  r = await app.request("/api/admin/businesses", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      businessName: "Dogfood Admin-Created Co",
      ownerEmail: TEST_EMAIL,
      ownerName: "Ada AdminCreated",
      serviceArea: { zipCodes: ["49221"], cities: ["Adrian"] },
      services: [{ name: "AI Receptionist", description: "test service", priceCents: 0, durationMin: 30 }],
      knowledgeBase: [{ kind: "faq", question: "Test?", answer: "Test answer." }],
    }),
  });
  const c4 = await r.json().catch(() => ({}));
  pass("C4 admin POST -> 201", r.status === 201 && !!c4.business?.id, `status=${r.status} id=${c4.business?.id ?? "none"}`);
  pass("C5 temporary password returned", typeof c4.temporaryPassword === "string" && c4.temporaryPassword.length >= 8, `len=${String(c4.temporaryPassword ?? "").length}`);
  const createdOwner = await repo.getUserByEmail(TEST_EMAIL);
  const createdBiz = createdOwner ? await repo.getBusinessForUser(createdOwner.id) : null;
  pass("C6 owner + business persisted", !!createdOwner && createdOwner.role === "owner" && !!createdBiz && createdBiz.name === "Dogfood Admin-Created Co", createdBiz?.name ?? "none");
  if (createdBiz) {
    const cServices = await repo.listServices(createdBiz.id);
    const cKb = await repo.listKnowledge(createdBiz.id);
    const cRules = await repo.listAutomationRules(createdBiz.id);
    const cArea = JSON.parse(createdBiz.serviceAreaJson || "{}") as { zipCodes?: string[] };
    pass("C7 services + KB persisted", cServices.length === 1 && cKb.length === 1, `svc=${cServices.length} kb=${cKb.length}`);
    pass("C8 service area persisted", cArea.zipCodes?.includes("49221") === true, JSON.stringify(cArea));
    pass("C9 default rules created by admin route", cRules.length === 8, `n=${cRules.length}`);
  }

  // C10: duplicate owner email -> 409.
  r = await app.request("/api/admin/businesses", { method: "POST", headers: { "content-type": "application/json", cookie: adminCookie }, body: JSON.stringify({ businessName: "Another Co", ownerEmail: TEST_EMAIL, ownerName: "Someone" }) });
  pass("C10 duplicate owner email -> 409", r.status === 409, `status=${r.status}`);

  // C11: explicit owner password honored (round-trips through verifyPassword).
  r = await app.request("/api/admin/businesses", { method: "POST", headers: { "content-type": "application/json", cookie: adminCookie }, body: JSON.stringify({ businessName: "Dogfood Password Co", ownerEmail: "dogfood-password@test.local", ownerName: "P W", ownerPassword: "explicit-pass-123" }) });
  const c11 = await r.json().catch(() => ({}));
  const pwUser = await repo.getUserByEmail("dogfood-password@test.local");
  const { verifyPassword } = await import("./src/server/auth/password");
  pass("C11 explicit password accepted", r.status === 201 && c11.temporaryPassword === "explicit-pass-123" && !!pwUser && verifyPassword("explicit-pass-123", pwUser.passwordHash), `status=${r.status}`);
  let pwBiz: typeof createdBiz = null;
  if (pwUser) pwBiz = await repo.getBusinessForUser(pwUser.id);

  // C12: audit rows written for admin provisioning (check BEFORE any wipe —
  // wiping a business also wipes its audit rows).
  const audits = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, "admin.business.create")).execute();
  pass("C12 admin.business.create audited", audits.length >= 2, `n=${audits.length}`);

  // -------------------------------------------------------------- cleanup
  if (createdBiz) await wipeBusiness(createdBiz.id);
  if (pwBiz) await wipeBusiness(pwBiz.id);
  // Non-admin test user (no business) + sessions.
  await db.delete(s.sessions).where(eq(s.sessions.userId, nonAdmin.id)).execute();
  await db.delete(s.users).where(eq(s.users.id, nonAdmin.id)).execute();
  await db.delete(s.sessions).where(eq(s.sessions.userId, admin.id)).execute();

  // Remove this run's audit rows (they reference cleaned-up businesses).
  await db.delete(s.auditLogs).where(eq(s.auditLogs.action, "admin.business.create")).execute();

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("dogfood-test failed:", err);
  process.exit(1);
});
