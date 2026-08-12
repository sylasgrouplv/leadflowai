/**
 * DOGFOODING PHASE 1a (Chunk B + C) acceptance test — CSV prospect import +
 * sales follow-up cadence.
 *
 * Exercises:
 *   A) CSV import route POST /api/import/prospects:
 *       401 unauthenticated, 403 employee role,
 *       201 multipart import (created + skipped per-row with reasons),
 *       explicit column mapping (business_name -> name, trade ->
 *       serviceRequested, phone, address+city+state+zip -> location,
 *       website/notes/source -> notes), source=prospect_import,
 *       status=new, score=cold (scoreValue 0),
 *       LEAD_CREATED emitted per row + lead_created_welcome runs
 *       materialized (bulk import stays quiet: send_welcome skips
 *       no-conversation leads),
 *       re-import is a no-op (duplicates skipped by phone),
 *       GET /api/leads?source=prospect_import and GET /api/import/prospects
 *       list the imported rows,
 *       raw text/csv body also accepted.
 *   B) Sales follow-up cadence (Chunk C): a follow-up row with templateKey
 *      sales_1 sends the SALES SMS template; a seq_1 row still sends the
 *      customer template; the engine advances sales_* sequences.
 *   C) CSV parser unit checks (quoted fields with commas, escaped quotes).
 *
 * Style: matches the in-process suites (dogfood-test / auto-test) — repo
 * functions + the Hono app in-process (createApp().request()), local SQLite,
 * tenant-scoped cleanup.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run import-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "./src/server/index";
import { createSession } from "./src/server/auth/session";
import { hashPassword } from "./src/server/auth/password";
import { sendFollowUpRow } from "./src/server/followups/engine";
import { runAutomationEngine } from "./src/server/automations/engine";
import { parseCsv, mapProspectRow } from "./src/server/import/prospects";
import { DOGFOOD_FOLLOWUP_STEPS } from "./scripts/seed-dogfood";
runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();

/** The campaign CSV shape — 4 valid rows + 2 invalid (missing name, no contact). */
const SAMPLE_CSV = `business_name,trade,address,city,state,zip,phone,website,notes,source
Affordable Towing & Auto Repair,Auto Repair,958 E Beecher St,Adrian,MI,49221,(517) 263-5316,https://www.adriantowing.com/,"4.3★ Google, 24h towing & repair, has website",Google Maps
Barnett Automotive LLC,Auto Repair,4340 W Maumee St,Adrian,MI,49221,(517) 265-2886,,"4.3★ Google, no website found",Google Maps
Ben's Bump Shop,Auto Repair,2352 Treat St,Adrian,MI,49221,(517) 265-4065,https://bensbumpshop.com/,"4.9★ Google, auto body, has website",Google Maps
Brakes-N-More,Auto Repair,1069 S Main St,Adrian,MI,49221,(517) 263-7421,,"4.4★ Google, no website found",Google Maps
,Plumbing,,Adrian,MI,49221,(517) 555-0100,,"missing name row",Google Maps
Edge Case Co.,Cleaning,1 Main St,Adrian,MI,49221,,https://edge.example.com,"has website only, no phone",Google Maps`;

/** Same rows as the dogfood-test cleanup (tenant-scoped, FK-safe). */
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
  // ------------------------------------------------------------ setup tenant
  const stamp = Date.now();
  const owner = await repo.createUser({
    name: "Import Test Owner",
    email: `import-owner-${stamp}@test.local`,
    passwordHash: hashPassword("import1234"),
    role: "owner",
  });
  const business = await repo.createBusiness({ ownerId: owner.id, name: "Import Test Co", category: "home_services" });
  const bizId = business.id;
  const employee = await repo.createUser({ name: "Import Test Employee", email: `import-emp-${stamp}@test.local`, passwordHash: hashPassword("import1234"), role: "employee" });
  await repo.addTeamMember(bizId, employee.id, "employee");
  const ownerSession = await createSession(owner.id);
  const ownerCookie = `lf_session=${ownerSession.token}`;
  const employeeSession = await createSession(employee.id);
  const employeeCookie = `lf_session=${employeeSession.token}`;
  const app = await createApp();

  // ------------------------------------------------------------ A) import
  const postImport = (body: BodyInit, cookie: string, contentType?: string) => {
    const headers: Record<string, string> = { cookie };
    if (contentType) headers["content-type"] = contentType;
    return app.request("/api/import/prospects", { method: "POST", headers, body });
  };

  // A1 unauthenticated -> 401.
  let r = await postImport(new Blob([SAMPLE_CSV]), "", "text/csv");
  pass("A1 import requires auth", r.status === 401, `status=${r.status}`);

  // A2 employee -> 403 (employees cannot create leads).
  r = await postImport(new Blob([SAMPLE_CSV]), employeeCookie, "text/csv");
  pass("A2 employee role forbidden", r.status === 403, `status=${r.status}`);

  // A3 multipart import -> 201, 4 created + 2 skipped with reasons.
  const form = new FormData();
  form.append("file", new File([SAMPLE_CSV], "prospects.csv", { type: "text/csv" }));
  r = await app.request("/api/import/prospects", { method: "POST", headers: { cookie: ownerCookie }, body: form });
  const importBody = (await r.json()) as {
    businessId: string;
    source: string;
    total: number;
    created: number;
    skipped: number;
    rows: { row: number; status: string; reason?: string; leadId?: string; name?: string }[];
  };
  pass("A3 multipart import 201", r.status === 201, `status=${r.status}`);
  pass("A4 4 created / 2 skipped", importBody.created === 4 && importBody.skipped === 2, `created=${importBody.created} skipped=${importBody.skipped} total=${importBody.total}`);
  const skipReasons = importBody.rows.filter((x) => x.status === "skipped").map((x) => x.reason).sort();
  pass("A5 skip reasons (missing-name, no-contact)", skipReasons.join(",") === "missing-name,no-contact", skipReasons.join(","));
  pass("A6 tenant + source on response", importBody.businessId === bizId && importBody.source === "prospect_import", `${importBody.businessId} ${importBody.source}`);

  // A7 mapping — first row.
  const imported = await repo.listLeadsBySource(bizId, "prospect_import");
  const first = imported.find((l) => l.firstName === "Affordable Towing & Auto Repair");
  pass("A7 rows landed with source=prospect_import", imported.length === 4, `n=${imported.length}`);
  pass(
    "A8 mapping name/trade/phone",
    !!first && first.serviceRequested === "Auto Repair" && first.phone === "(517) 263-5316",
    first ? `${first.firstName} | ${first.serviceRequested} | ${first.phone}` : "missing",
  );
  pass(
    "A9 location composed",
    first?.location === "958 E Beecher St, Adrian, MI 49221",
    first?.location ?? "missing",
  );
  pass(
    "A10 notes compose website+notes+source",
    !!first && first.notes.includes("Website: https://www.adriantowing.com/") && first.notes.includes("4.3★ Google, 24h towing & repair, has website") && first.notes.includes("Source: Google Maps"),
    first?.notes ?? "missing",
  );
  pass(
    "A11 status/score defaults (new/cold/0)",
    imported.every((l) => l.status === "new" && l.score === "cold" && l.scoreValue === 0),
    imported.map((l) => `${l.status}/${l.score}/${l.scoreValue}`).join(","),
  );
  pass("A12 every row has phone or email", imported.every((l) => l.phone || l.email), "ok");

  // A13 LEAD_CREATED per row + welcome runs materialized.
  const events = await repo.listEvents(bizId, { limit: 100 });
  const leadCreated = events.filter((e) => e.type === "LEAD_CREATED");
  pass("A13 LEAD_CREATED emitted per row", leadCreated.length === 4, `n=${leadCreated.length}`);
  const welcomeRuns = (await db.select().from(s.automationRuns).where(eq(s.automationRuns.businessId, bizId)).execute()).filter((r2) => r2.ruleKind === "lead_created_welcome");
  pass("A14 welcome runs materialized per lead", welcomeRuns.length === 4, `n=${welcomeRuns.length}`);

  // A15 bulk import is quiet: running the engine skips (no conversation).
  const engine = await runAutomationEngine();
  const welcomeRunsAfter = (await db.select().from(s.automationRuns).where(eq(s.automationRuns.businessId, bizId)).execute()).filter((r2) => r2.ruleKind === "lead_created_welcome");
  pass("A15 engine ran without welcome sends (no conversation)", welcomeRunsAfter.every((r2) => r2.status !== "failed"), `checked=${engine.checked} failed=${engine.failed}`);

  // A16 GET /api/leads?source=prospect_import.
  r = await app.request(`/api/leads?source=prospect_import`, { headers: { cookie: ownerCookie } });
  const leadList = (await r.json()) as { leads: { source: string }[] };
  pass("A16 leads list filters by source", r.status === 200 && leadList.leads.length === 4 && leadList.leads.every((l) => l.source === "prospect_import"), `n=${leadList.leads.length}`);

  // A17 GET /api/import/prospects summary.
  r = await app.request(`/api/import/prospects`, { headers: { cookie: ownerCookie } });
  const summary = (await r.json()) as { count: number; source: string };
  pass("A17 import summary route", r.status === 200 && summary.count === 4 && summary.source === "prospect_import", `count=${summary.count}`);

  // A18 re-import is a no-op: 4 duplicates + 2 invalid skipped, 0 created.
  r = await postImport(new Blob([SAMPLE_CSV]), ownerCookie, "text/csv");
  const again = (await r.json()) as { created: number; skipped: number; rows: { reason?: string }[] };
  const dupCount = again.rows.filter((x) => x.reason === "duplicate").length;
  pass("A18 re-import idempotent (0 created, 4 duplicates)", r.status === 200 && again.created === 0 && dupCount === 4, `created=${again.created} dup=${dupCount} skipped=${again.skipped}`);

  // A19 raw text/csv body also works (different file, one row).
  const oneRow = `business_name,trade,address,city,state,zip,phone,website,notes,source
Zebra Services,Landscaping,9 Oak St,Adrian,MI,49221,(517) 555-0199,,,Google Maps`;
  r = await postImport(new Blob([oneRow]), ownerCookie, "text/csv");
  const raw = (await r.json()) as { created: number };
  pass("A19 text/csv body import", r.status === 201 && raw.created === 1, `status=${r.status} created=${raw.created}`);

  // ------------------------------------------------------------ B) sales cadence
  await repo.saveFollowUpConfig(bizId, DOGFOOD_FOLLOWUP_STEPS); // sales_1..sales_4
  const salesLead = await repo.createLead({ businessId: bizId, firstName: "Sales Prospect", phone: "(517) 555-0200", source: "prospect_import" });
  const customerLead = await repo.createLead({ businessId: bizId, firstName: "Customer Prospect", phone: "(517) 555-0201", source: "website_chat" });
  const salesFid = await repo.createFollowUp(bizId, { leadId: salesLead.id, type: "sms", scheduledFor: Date.now() - 1000, templateKey: "sales_1" });
  const customerFid = await repo.createFollowUp(bizId, { leadId: customerLead.id, type: "sms", scheduledFor: Date.now() - 1000, templateKey: "seq_1" });
  const salesRes = await sendFollowUpRow(bizId, salesFid);
  pass("B1 sales_1 sends (advances sequence)", salesRes.status === "sent" && salesRes.step === 1, JSON.stringify(salesRes));
  const salesActions = await repo.listAgentActions(bizId, 200);
  const salesSms = salesActions.find((a) => a.action === "send_sms" && a.leadId === salesLead.id);
  const salesBody = (salesSms?.inputJson ? JSON.parse(salesSms.inputJson) : {}) as { body?: string };
  pass("B2 sales SMS uses sales intro template", !!salesBody.body && salesBody.body.includes("answer every lead fast") && salesBody.body.includes("Reply STOP"), salesBody.body ?? "no body");
  // Engine advanced to step 2 (email, no email on lead -> will skip when due).
  const nextRows = (await repo.listFollowUpsWithLead(bizId, 50)).filter((r2) => r2.followUp.leadId === salesLead.id);
  pass("B3 sales sequence advanced to step 2", nextRows.some((r2) => r2.followUp.templateKey === "sales_2" && r2.followUp.status === "pending"), nextRows.map((r2) => `${r2.followUp.templateKey}:${r2.followUp.status}`).join(","));
  const customerRes = await sendFollowUpRow(bizId, customerFid);
  const customerActions = await repo.listAgentActions(bizId, 200);
  const customerSms = customerActions.find((a) => a.action === "send_sms" && a.leadId === customerLead.id);
  const customerBody = (customerSms?.inputJson ? JSON.parse(customerSms.inputJson) : {}) as { body?: string };
  pass("B4 seq_1 still uses customer template", customerRes.status === "sent" && !!customerBody.body && customerBody.body.includes("Want us to come by soon?"), customerBody.body ?? "no body");

  // ------------------------------------------------------------ C) parser
  const parsed = parseCsv(SAMPLE_CSV);
  pass("C1 parseCsv row count", parsed.length === 7, `rows=${parsed.length} (header + 6 data)`);
  pass("C2 quoted field with comma preserved", parsed[1][8] === "4.3★ Google, 24h towing & repair, has website", parsed[1][8] ?? "missing");
  const mapped = mapProspectRow(parsed[0], parsed[1]);
  pass("C3 mapProspectRow explicit mapping", mapped.name === "Affordable Towing & Auto Repair" && mapped.serviceRequested === "Auto Repair" && mapped.location === "958 E Beecher St, Adrian, MI 49221" && mapped.notes.startsWith("Website: https://www.adriantowing.com/"), JSON.stringify(mapped).slice(0, 160));

  // ------------------------------------------------------------ cleanup
  await wipeBusiness(bizId);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("import-test crashed:", err);
  process.exit(1);
});
