/**
 * PHASE 3 / CHUNK I — PROSPECT RESEARCH (`research_prospect` READ tool +
 * WebFetchProvider interface + mock) acceptance test.
 *
 * Dogfooding item #2 ("Prospect research: automated enrichment of prospect
 * data") — a controlled, permission-gated research capability in the AI tool
 * registry:
 *
 *   R1  registry: `research_prospect` registered as READ (never HIGH_RISK),
 *       audit on, AI-accessible; READ tool count grows by exactly one
 *   R2  WebFetchProvider factory + mock: `getWebFetchProvider()` returns the
 *       mock; results are DETERMINISTIC, clearly labeled (isMock + note), and
 *       facts-only (no pricing/availability fields at all)
 *   R3  agent path (the orchestrator's callAiTool path): Lead Qualification
 *       agent researches a prospect lead → grounded result incl. lead_id,
 *       normalized website, service keywords
 *   R4  validation: missing lead_id → invalid_input (zod), audit-logged
 *   R5  tenant isolation: a foreign business's lead → tenant_mismatch,
 *       audit-logged, nothing changed
 *   R6  audit log: successful research writes one agent_actions row with the
 *       result payload
 *   R7  NO DB WRITES by the tool itself: lead row untouched (notes/status/
 *       score/updatedAt), zero events emitted, the ONLY new row is the audit
 *       entry (persistence stays in WRITE tools)
 *   R8  defaults: domain resolved from the lead's notes "Website: …" (the
 *       prospect-import shape) and the trade detected from the lead name
 *
 * Offline + deterministic: the mock provider performs NO network calls and
 * every fixture is labeled sample data (never real-looking facts).
 *
 * Style: matches invoice-test.ts (in-process suite) — repo functions + the
 * tool registry, local SQLite, tenant-scoped cleanup.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run research-prospect-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { and, eq } from "drizzle-orm";
import { callAiTool, TOOL_REGISTRY, AI_ACCESSIBLE_TOOLS, ToolError, type ToolContext } from "./src/server/ai/tools/registry";
import { getWebFetchProvider } from "./src/server/integrations";

runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();
const SOURCE = "research_prospect_test";

async function wipeBusiness(id: string) {
  for (const lead of await db.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.businessId, id)).execute()) {
    await db.delete(s.appointments).where(eq(s.appointments.leadId, lead.id)).execute();
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
  await db.delete(s.notifications).where(eq(s.notifications.businessId, id)).execute();
  await db.delete(s.usageEvents).where(eq(s.usageEvents.businessId, id)).execute();
  await db.delete(s.auditLogs).where(eq(s.auditLogs.businessId, id)).execute();
  await db.delete(s.widgetSettings).where(eq(s.widgetSettings.businessId, id)).execute();
  await db.delete(s.integrations).where(eq(s.integrations.businessId, id)).execute();
  await db.delete(s.subscriptions).where(eq(s.subscriptions.businessId, id)).execute();
  await db.delete(s.services).where(eq(s.services.businessId, id)).execute();
  await db.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, id)).execute();
  await db.delete(s.reviewConfigs).where(eq(s.reviewConfigs.businessId, id)).execute();
  await db.delete(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, id)).execute();
  await db.delete(s.invoices).where(eq(s.invoices.businessId, id)).execute();
  await db.delete(s.businessReports).where(eq(s.businessReports.businessId, id)).execute();
  const members = await db.select({ userId: s.teamMembers.userId }).from(s.teamMembers).where(eq(s.teamMembers.businessId, id)).execute();
  await db.delete(s.teamMembers).where(eq(s.teamMembers.businessId, id)).execute();
  await db.delete(s.businesses).where(eq(s.businesses.id, id)).execute();
  for (const m of members) {
    await db.delete(s.sessions).where(eq(s.sessions.userId, m.userId)).execute();
    const stillOwned = (await db.select({ n: s.businesses.id }).from(s.businesses).where(eq(s.businesses.ownerId, m.userId)).limit(1).execute()).length > 0;
    if (stillOwned) continue;
    await db.delete(s.users).where(eq(s.users.id, m.userId)).execute();
  }
}

function resultOf(a: { resultJson: string | null }) {
  try {
    return JSON.parse(a.resultJson ?? "{}");
  } catch {
    return {};
  }
}

(async () => {
  const stamp = Date.now();
  const owner = await repo.createUser({ name: "Research Test Owner", email: `research-owner-${stamp}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
  const business = await repo.createBusiness({ ownerId: owner.id, name: "Research Test Co", category: "home_services" });
  const bizId = business.id;

  // =========================================================================
  console.log("\n== R1 registry — READ tool, permission-gated ==");
  const tool = TOOL_REGISTRY.find((t) => t.name === "research_prospect");
  pass("R1a research_prospect registered", !!tool, tool ? "" : "missing");
  pass("R1b permission level READ (never HIGH_RISK)", tool?.permissionLevel === "READ", `level=${tool?.permissionLevel}`);
  pass("R1c audit always on + full def", !!tool && tool.audit === true && tool.description.length > 0 && !!tool.inputSchema && typeof tool.validate === "function" && typeof tool.handler === "function", "");
  pass("R1d AI can call it (AI_ACCESSIBLE_TOOLS includes it, no HIGH_RISK leaked)", AI_ACCESSIBLE_TOOLS.includes("research_prospect") && tool?.permissionLevel !== "HIGH_RISK", "");
  const readTools = TOOL_REGISTRY.filter((t) => t.permissionLevel === "READ").map((t) => t.name);
  pass("R1e READ tools = previous 4 + research_prospect", readTools.length === 5 && readTools.every((n) => ["get_business_info", "get_lead", "get_service", "check_calendar", "research_prospect"].includes(n)), `READ=${readTools.join(",")}`);

  // =========================================================================
  console.log("\n== R2 WebFetchProvider factory + mock (offline, labeled) ==");
  const provider = getWebFetchProvider();
  pass("R2a factory returns the mock by default (config-only swap)", provider.name === "mock-web-fetch", `name=${provider.name}`);
  const first = await provider.fetch({ name: "Smith's Heating & Cooling", domain: "smithhvac.com" });
  const second = await provider.fetch({ name: "Smith's Heating & Cooling", domain: "smithhvac.com" });
  pass("R2b deterministic — same input → identical output", JSON.stringify(first) === JSON.stringify(second), "");
  pass("R2c clearly labeled mock (isMock + note)", first.isMock === true && /MOCK DATA/.test(first.note) && first.provider === "mock-web-fetch", `note=${first.note.slice(0, 60)}`);
  pass("R2d facts-only shape — no pricing/availability fields", !("priceCents" in first) && !("pricing" in first) && !("availability" in first) && !("slots" in first), `keys=${Object.keys(first).join(",")}`);
  pass("R2e website normalized from domain", first.website === "https://smithhvac.com" && first.resolvedDomain === "smithhvac.com", first.website ?? "");
  pass("R2f service keywords + labeled review snippets present", Array.isArray(first.serviceKeywords) && first.serviceKeywords.length > 0 && first.reviewSnippets.every((snp) => snp.source.startsWith("Sample")), `kw=${first.serviceKeywords.join("|")}`);
  pass("R2g safety disclaimer present", first.disclaimer.length > 0 && /no pricing/i.test(first.disclaimer), "");
  // No domain → sample host on the reserved .example.test TLD, still labeled.
  const noDomain = await provider.fetch({ name: "Example Plumbing" });
  pass("R2h no domain → clearly-fake sample host (.example.test)", !!noDomain.website?.endsWith(".example.test") && noDomain.isMock === true && noDomain.website !== "https://exampleplumbing.com", noDomain.website ?? "");

  // =========================================================================
  console.log("\n== R3 agent path (orchestrator's callAiTool route) ==");
  const ctx: ToolContext = { businessId: bizId, agent: "qualification" };
  const lead = await repo.createLead({
    businessId: bizId,
    firstName: "Smith's Heating & Cooling",
    lastName: "",
    source: SOURCE,
    serviceRequested: "HVAC repair",
    location: "Adrian, MI",
    notes: "Website: https://smithhvac.com\nSource: prospect_import",
  });
  const research = (await callAiTool("research_prospect", { ...ctx, leadId: lead.id }, { lead_id: lead.id, domain: "smithhvac.com" })) as Record<string, unknown>;
  pass("R3a tool call via callAiTool succeeds", !!research && research.lead_id === lead.id, `lead_id=${research.lead_id}`);
  pass("R3b grounded result — labeled mock facts", research.isMock === true && research.provider === "mock-web-fetch" && Array.isArray(research.serviceKeywords), "");
  pass("R3c trade detected from identity (HVAC keywords)", Array.isArray(research.serviceKeywords) && (research.serviceKeywords as string[]).some((k) => /AC repair|furnace/i.test(k)), `kw=${JSON.stringify(research.serviceKeywords)}`);
  pass("R3d website normalized from provided domain", research.website === "https://smithhvac.com", String(research.website));

  // =========================================================================
  console.log("\n== R4 validation failure (missing lead_id) ==");
  {
    let code = "";
    try {
      await callAiTool("research_prospect", ctx, { domain: "smithhvac.com" });
    } catch (e) {
      code = e instanceof ToolError ? e.code : String(e);
    }
    pass("R4a missing lead_id → invalid_input", code === "invalid_input", `code=${code}`);
    const actions = await repo.listAgentActions(bizId, 200);
    const failed = actions.filter((a) => a.action === "research_prospect" && a.success === 0).at(-1);
    const r = failed ? resultOf(failed) : {};
    pass("R4b validation failure audit-logged (success=0, invalid-input)", !!failed && r.error === "invalid-input", `result=${JSON.stringify(r)}`);
  }

  // =========================================================================
  console.log("\n== R5 tenant isolation (foreign lead rejected) ==");
  let foreignBizId = "";
  let foreignUserId = "";
  let foreignLeadId = "";
  {
    const fUser = await repo.createUser({ name: "Foreign Owner", email: `research-foreign-${stamp}@test.local`, passwordHash: "$2b$10$test", role: "owner" });
    foreignUserId = fUser.id;
    const fBiz = await repo.createBusiness({ ownerId: fUser.id, name: "Foreign Roofing Co", category: "home_services" });
    foreignBizId = fBiz.id;
    const fLead = await repo.createLead({ businessId: foreignBizId, firstName: "Foreign Roofing", lastName: "", source: SOURCE, notes: "Website: https://foreignroofing.example.test" });
    foreignLeadId = fLead.id;
    let code = "";
    try {
      await callAiTool("research_prospect", { businessId: bizId, agent: "qualification" }, { lead_id: foreignLeadId });
    } catch (e) {
      code = e instanceof ToolError ? e.code : String(e);
    }
    pass("R5a foreign lead → tenant_mismatch", code === "tenant_mismatch", `code=${code}`);
    const actions = await repo.listAgentActions(bizId, 300);
    const denied = actions.filter((a) => a.action === "research_prospect" && a.inputJson?.includes(foreignLeadId)).at(-1);
    const r = denied ? resultOf(denied) : {};
    pass("R5b tenant rejection audit-logged (success=0, rejected=true)", !!denied && denied.success === 0 && r.rejected === true, `result=${JSON.stringify(r)}`);
    // The foreign lead must be untouched (no data was written anywhere).
    const after = await repo.getLeadById(foreignBizId, foreignLeadId);
    pass("R5c foreign lead unchanged", !!after && after.status === "new" && after.score === "cold", `status=${after?.status}`);
  }

  // =========================================================================
  console.log("\n== R6 audit log entry (successful research) ==");
  {
    const actions = await repo.listAgentActions(bizId, 400);
    const audit = actions.filter((a) => a.action === "research_prospect" && a.leadId === lead.id && a.success === 1).at(-1);
    const r = audit ? resultOf(audit) : {};
    pass("R6a success audit row exists with agent + lead", !!audit && audit.agent === "qualification" && audit.leadId === lead.id, audit ? `agent=${audit.agent}` : "missing");
    pass("R6b audit payload carries the labeled mock result", !!audit && r.isMock === true && r.lead_id === lead.id && r.provider === "mock-web-fetch", `result=${JSON.stringify(r).slice(0, 80)}`);
  }

  // =========================================================================
  console.log("\n== R7 no DB writes by the tool itself ==");
  {
    const before = await repo.getLeadById(bizId, lead.id);
    const beforeEvents = (await db.select().from(s.events).where(and(eq(s.events.businessId, bizId), eq(s.events.leadId, lead.id))).execute()).length;
    const beforeActions = (await db.select().from(s.agentActions).where(eq(s.agentActions.leadId, lead.id)).execute()).length;
    await callAiTool("research_prospect", { ...ctx, leadId: lead.id }, { lead_id: lead.id, name: "Smith's Heating & Cooling" });
    const after = await repo.getLeadById(bizId, lead.id);
    const afterEvents = (await db.select().from(s.events).where(and(eq(s.events.businessId, bizId), eq(s.events.leadId, lead.id))).execute()).length;
    const afterActions = (await db.select().from(s.agentActions).where(eq(s.agentActions.leadId, lead.id)).execute()).length;
    pass("R7a lead row byte-for-byte untouched", !!before && !!after && before.notes === after.notes && before.status === after.status && before.score === after.score && before.scoreValue === after.scoreValue && before.updatedAt === after.updatedAt, `updatedAt ${before?.updatedAt}→${after?.updatedAt}`);
    pass("R7b zero events emitted", beforeEvents === afterEvents && afterEvents === 0, `events=${afterEvents}`);
    pass("R7c the ONLY new row is the audit entry (+1)", beforeActions + 1 === afterActions, `agent_actions ${beforeActions}→${afterActions}`);
  }

  // =========================================================================
  console.log("\n== R8 defaults — domain from lead notes + trade from name ==");
  {
    // No domain/name args at all: the tool derives identity from the lead.
    const res = (await callAiTool("research_prospect", { ...ctx, leadId: lead.id }, { lead_id: lead.id })) as Record<string, unknown>;
    pass("R8a domain auto-resolved from notes 'Website: …'", res.resolvedDomain === "smithhvac.com" && res.website === "https://smithhvac.com", `domain=${res.resolvedDomain}`);
    pass("R8b trade detected from lead name (HVAC keywords)", Array.isArray(res.serviceKeywords) && (res.serviceKeywords as string[]).some((k) => /AC repair|furnace/i.test(k)), `kw=${JSON.stringify(res.serviceKeywords)}`);
  }

  // =========================================================================
  // Cleanup (tenant-scoped; foreign business first — owner user shared pattern)
  // =========================================================================
  if (foreignBizId) await wipeBusiness(foreignBizId);
  await wipeBusiness(bizId);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`} — research-prospect-test`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("research-prospect-test crashed:", e);
  process.exit(1);
});
