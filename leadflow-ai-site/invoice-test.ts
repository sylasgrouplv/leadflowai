/**
 * DOGFOODING PHASE 2 / Chunk H acceptance test — invoice reminders on the
 * automation engine (automation #10).
 *
 * Exercises:
 *   T1  default `invoice_reminder` rule materializes for new tenants (8 rules)
 *   T2  `create_invoice` tool: valid input → row + INVOICE_CREATED event;
 *       invalid input → rejected by zod validation
 *   T3  tenant isolation: schedule_invoice_reminder / repo reads reject
 *       cross-business invoice ids
 *   T4  INVOICE_CREATED → engine → invoice_reminder follow-up row + run at
 *       (due date − lead time, default 48h), customer lead created (source invoice)
 *   T5  re-emitted INVOICE_CREATED is idempotent (no duplicate reminder)
 *   T6  send path: due run → honest email via mock provider (audited), row
 *       sent, FOLLOWUP_SENT emitted, owner notification created
 *   T7  markInvoicePaid → pending reminder cancelled immediately (never sent)
 *   T8  fire-time re-check: invoice paid/cancelled before send → cancelled,
 *       never sent
 *   T9  opted-out customer → nothing scheduled
 *   T10 template honesty: real invoice number / amount / due date, opt-out
 *       line, no manufactured urgency ("Action Required" forbidden)
 *   T11 stop rules exempt invoice reminders (cancelFollowUpsForLead keeps them)
 *
 * Style: matches reminder-test.ts (in-process suites) — repo functions + the
 * automation engine + tool registry, local SQLite, tenant-scoped cleanup.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run invoice-test.ts
 *       (HTTP-free, so it also runs from /home/team/shared/site)
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { and, eq } from "drizzle-orm";
import { runAutomationEngine } from "./src/server/automations/engine";
import { ensureDogfoodRules } from "./scripts/seed-dogfood";
import { callAiTool, type ToolContext } from "./src/server/ai/tools/registry";
import { INVOICE_REMINDER_TEMPLATE_KEY, invoiceEmail, fmtAmountCents, fmtDueDate, invoiceNumberFor, getInvoiceReminderLeadTimeHours, INVOICE_LEAD_TIME_DEFAULT_HOURS } from "./src/server/invoices/agent";

runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();

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
  await db.delete(s.invoices).where(eq(s.invoices.businessId, id)).execute();
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
    const stillOwned = (await db.select({ n: s.businesses.id }).from(s.businesses).where(eq(s.businesses.ownerId, m.userId)).limit(1).execute()).length > 0;
    const stillMember = (await db.select({ n: s.teamMembers.userId }).from(s.teamMembers).where(eq(s.teamMembers.userId, m.userId)).limit(1).execute()).length > 0;
    if (stillOwned || stillMember) continue; // shared owner (T3 biz2) — leave the user for the last wipe
    await db.delete(s.users).where(eq(s.users.id, m.userId)).execute();
  }
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

(async () => {
  const stamp = Date.now();
  const owner = await repo.createUser({ name: "Invoice Test Owner", email: `invoice-owner-${stamp}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
  const business = await repo.createBusiness({ ownerId: owner.id, name: "Invoice Test Co", category: "home_services" });
  const bizId = business.id;
  const ctx: ToolContext = { businessId: bizId, agent: "invoice-test" };

  // ------------------------------------------------------------ T1 rule
  await ensureDogfoodRules(bizId);
  const rules = await repo.listAutomationRules(bizId);
  const invRule = rules.find((r) => r.name === "invoice_reminder");
  pass(
    "T1 invoice_reminder default rule wired",
    !!invRule && invRule.triggerEvent === "INVOICE_CREATED" && invRule.action === "schedule_invoice_reminder" && invRule.conditionJson.includes("none") && invRule.delayMs === 0,
    invRule ? `${invRule.triggerEvent}→${invRule.action} delay=${invRule.delayMs}` : "missing"
  );
  pass("T1b eight default rules (dogfood)", rules.length === 8, `n=${rules.length}`);
  const cfg = invRule?.actionConfigJson ? (JSON.parse(invRule.actionConfigJson) as { lead_hours?: number }) : {};
  pass("T1c default lead time 48 in rule actionConfig", cfg.lead_hours === 48, JSON.stringify(cfg));
  pass("T1d getInvoiceReminderLeadTimeHours default", (await getInvoiceReminderLeadTimeHours(bizId)) === INVOICE_LEAD_TIME_DEFAULT_HOURS, "");

  // ------------------------------------------------------------ T2 tool
  const dueAt = repo.now() + 5 * DAY;
  const created = (await callAiTool("create_invoice", ctx, {
    customer_name: "Ada Homeowner",
    customer_email: "ada@example.test",
    amount_cents: 24950,
    due_at: dueAt,
  })) as { id: string; status: string; amountCents: number; dueAt: number };
  pass("T2a create_invoice returns row", !!created?.id && created.status === "unpaid" && created.amountCents === 24950, JSON.stringify(created));
  const invEvent = await db.select().from(s.events).where(and(eq(s.events.businessId, bizId), eq(s.events.type, "INVOICE_CREATED"))).execute();
  pass("T2b INVOICE_CREATED event emitted with payload", invEvent.length === 1 && invEvent[0].payloadJson.includes(created.id), invEvent[0]?.payloadJson ?? "");
  let rejected = false;
  try {
    await callAiTool("create_invoice", ctx, { customer_name: "", customer_email: "bad", amount_cents: -5, due_at: 0 });
  } catch {
    rejected = true;
  }
  pass("T2c invalid input rejected by zod", rejected, "");

  // ------------------------------------------------------------ T3 isolation
  const biz2 = await repo.createBusiness({ ownerId: owner.id, name: "Other Co", category: "home_services" });
  let crossRejected = false;
  try {
    await callAiTool("schedule_invoice_reminder", ctx, { invoice_id: created.id }); // same tenant — ok (T4 covers)
  } catch {
    crossRejected = true;
  }
  pass("T3a same-tenant schedule accepted", !crossRejected, "");
  const crossCtx: ToolContext = { businessId: biz2.id, agent: "invoice-test" };
  let crossFail = false;
  try {
    await callAiTool("schedule_invoice_reminder", crossCtx, { invoice_id: created.id });
  } catch {
    crossFail = true;
  }
  pass("T3b cross-tenant schedule rejected", crossFail, "");
  pass("T3c cross-tenant getInvoiceById null", (await repo.getInvoiceById(biz2.id, created.id)) === null, "");

  // ------------------------------------------------------------ T4 engine
  await runAutomationEngine();
  const fups = await repo.listFollowUpsWithLead(bizId, 500);
  const invFups = fups.filter(({ followUp }) => followUp.templateKey === INVOICE_REMINDER_TEMPLATE_KEY);
  pass("T4a reminder follow-up row created", invFups.length === 1, `n=${invFups.length}`);
  const fup = invFups[0]?.followUp;
  const lead = invFups[0]?.lead;
  pass("T4b customer lead created (source invoice)", !!lead && lead.source === "invoice" && lead.email === "ada@example.test", JSON.stringify(lead));
  const scheduledFor = fup?.scheduledFor ?? 0;
  pass("T4c scheduled at due − 48h", Math.abs(scheduledFor - (dueAt - 48 * HOUR)) < 60_000, `scheduledFor=${scheduledFor} expected=${dueAt - 48 * HOUR}`);
  const run = await repo.getRunForFollowUp(fup!.id);
  const payload = run ? JSON.parse(run.payloadJson || "{}") : {};
  pass("T4d run payload carries invoiceId + dueAt", payload.invoiceId === created.id && payload.dueAt === dueAt, JSON.stringify(payload));

  // ------------------------------------------------------------ T5 idempotent
  const t5res = (await callAiTool("schedule_invoice_reminder", ctx, { invoice_id: created.id })) as { status?: string };
  const t5rows = await repo.listFollowUpsWithLead(bizId, 500);
  pass("T5 re-schedule is idempotent (no duplicate)", t5res.status === "already-scheduled" && t5rows.filter(({ followUp }) => followUp.templateKey === INVOICE_REMINDER_TEMPLATE_KEY).length === 1, `res=${t5res.status} n=${t5rows.filter(({ followUp }) => followUp.templateKey === INVOICE_REMINDER_TEMPLATE_KEY).length}`);

  // ------------------------------------------------------------ T6 send
  await repo.updateAutomationRun(bizId, run!.id, { runAt: repo.now() - 5000 });
  await runAutomationEngine();
  const sent = await db.select().from(s.followUps).where(eq(s.followUps.id, fup!.id)).execute();
  pass("T6a reminder row marked sent", sent[0]?.status === "sent", sent[0]?.status ?? "");
  const emailAudits = await db.select().from(s.agentActions).where(and(eq(s.agentActions.businessId, bizId), eq(s.agentActions.action, "send_email"))).execute();
  pass("T6b email send audited", emailAudits.length >= 1 && emailAudits.some((a) => a.inputJson.includes("ada@example.test")), `n=${emailAudits.length}`);
  const fsEvents = await db.select().from(s.events).where(and(eq(s.events.businessId, bizId), eq(s.events.type, "FOLLOWUP_SENT"))).execute();
  pass("T6c FOLLOWUP_SENT emitted", fsEvents.length >= 1, "");
  const notifs = await repo.listNotifications(bizId, 50);
  pass("T6d owner notification created", notifs.some((n) => n.kind === "invoice_reminder"), notifs.map((n) => n.kind).join(","));

  // ------------------------------------------------------------ T7 markInvoicePaid
  const inv2 = (await callAiTool("create_invoice", ctx, { customer_name: "Bob Builder", customer_email: "bob@example.test", amount_cents: 99900, due_at: repo.now() + 10 * DAY })) as { id: string };
  await runAutomationEngine();
  const fups2 = await repo.listFollowUpsWithLead(bizId, 500);
  const fup2 = fups2.find(({ followUp }) => followUp.templateKey === INVOICE_REMINDER_TEMPLATE_KEY && followUp.status === "pending");
  pass("T7a second invoice reminder pending", !!fup2, "");
  await repo.markInvoicePaid(bizId, inv2.id);
  const fup2after = await repo.listFollowUpsWithLead(bizId, 500);
  const fup2row = fup2after.find(({ followUp }) => followUp.id === fup2!.followUp.id);
  pass("T7b markInvoicePaid cancels pending reminder", fup2row?.followUp.status === "cancelled", fup2row?.followUp.status ?? "");

  // ------------------------------------------------------------ T8 fire-time re-check
  const inv3 = (await callAiTool("create_invoice", ctx, { customer_name: "Cara Client", customer_email: "cara@example.test", amount_cents: 15000, due_at: repo.now() + 10 * DAY })) as { id: string };
  await runAutomationEngine();
  const fups3 = await repo.listFollowUpsWithLead(bizId, 500);
  const fup3 = fups3.find(({ followUp }) => followUp.templateKey === INVOICE_REMINDER_TEMPLATE_KEY && followUp.status === "pending" && followUp.scheduledFor > repo.now());
  const run3 = await repo.getRunForFollowUp(fup3!.followUp.id);
  await repo.markInvoiceCancelled(bizId, inv3.id); // settle BEFORE the run fires
  await repo.updateAutomationRun(bizId, run3!.id, { runAt: repo.now() - 5000 });
  await runAutomationEngine();
  const fup3after = await db.select().from(s.followUps).where(eq(s.followUps.id, fup3!.followUp.id)).execute();
  pass("T8 cancelled invoice reminder never sent (cancelled at fire time)", fup3after[0]?.status === "cancelled" && fup3after[0]?.attempts === 0, fup3after[0]?.status ?? "");

  // ------------------------------------------------------------ T9 opt-out
  await repo.createLead({ businessId: bizId, firstName: "Opt", lastName: "Out", phone: "", email: "optout@example.test", source: "invoice", serviceRequested: "" });
  const optLead = (await repo.listLeads(bizId, 1000)).find((l) => l.email === "optout@example.test");
  await repo.updateLead(bizId, optLead!.id, { optedOut: 1 });
  const inv4 = (await callAiTool("create_invoice", ctx, { customer_name: "Opt Out", customer_email: "optout@example.test", amount_cents: 10000, due_at: repo.now() + 5 * DAY })) as { id: string };
  await runAutomationEngine();
  const fups4 = await repo.listFollowUpsWithLead(bizId, 500);
  const optRows = fups4.filter(({ followUp }) => followUp.templateKey === INVOICE_REMINDER_TEMPLATE_KEY && fups4.find((x) => x.lead?.id === optLead!.id));
  const optRow = fups4.find(({ followUp, lead: l }) => l?.id === optLead!.id && followUp.templateKey === INVOICE_REMINDER_TEMPLATE_KEY);
  pass("T9 opted-out customer gets no reminder", !optRow, JSON.stringify(optRows.map(({ followUp }) => followUp.status)));

  // ------------------------------------------------------------ T10 template
  const email = invoiceEmail({ firstName: "Ada", businessName: "Invoice Test Co", ownerName: "Test Owner", invoiceNumber: invoiceNumberFor(created.id), amount: fmtAmountCents(created.amountCents), dueDate: fmtDueDate(created.dueAt) });
  pass("T10a real amount in subject + body", email.subject.includes(fmtAmountCents(created.amountCents)) && email.html.includes(fmtAmountCents(created.amountCents)), email.subject);
  pass("T10b real due date in body", email.html.includes(fmtDueDate(created.dueAt)), "");
  pass("T10c real invoice number in subject + body", email.subject.includes(invoiceNumberFor(created.id)) && email.html.includes(invoiceNumberFor(created.id)), "");
  pass("T10d opt-out line present", email.html.toLowerCase().includes("opt out") || email.html.includes("STOP"), "");
  pass("T10e no manufactured urgency", !/action required|urgent|final notice/i.test(email.subject + email.html), email.subject);

  // ------------------------------------------------------------ T11 stop rules exempt
  const invoiceLead = fups.find(({ followUp }) => followUp.id === fup!.id)!.lead!;
  const before = await repo.listFollowUpsWithLead(bizId, 500);
  await repo.cancelFollowUpsForLead(bizId, invoiceLead.id); // generic stop rule (e.g. booking) fires
  const after11 = await repo.listFollowUpsWithLead(bizId, 500);
  const survivors = after11.filter(({ followUp }) => followUp.id === fup!.id);
  pass("T11 invoice reminder survives generic stop rules", survivors.length === 1 && survivors[0].followUp.status === "sent", survivors[0]?.followUp.status ?? "gone");

  // Wipe the second business first, then the main one — both share the owner
  // user, and businesses.ownerId → users.id has no ON DELETE, so the user is
  // only deleted once no business/team row references them anymore.
  await wipeBusiness(biz2.id);
  await wipeBusiness(bizId);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`} — invoice-test`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("invoice-test crashed:", e);
  process.exit(1);
});
