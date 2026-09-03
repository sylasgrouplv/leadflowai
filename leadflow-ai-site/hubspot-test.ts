/**
 * HubSpot CRM provider hermetic tests (Phase 1 task 1 — scope doc §6).
 *
 * Verifies the HubSpot ↔ LeadFlow record-sync groundwork WITHOUT network or
 * real keys: a fake `fetch` returns canned JSON per URL, and every client is
 * constructed with an explicit key so nothing reads HUBSPOT_* from the host.
 *
 * Covered:
 *   - auth header on every request (Bearer + content-type),
 *   - search by email (the §1.2 dedupe primitive): empty → null, hit → contact,
 *   - syncLead CREATE mapping (LeadFlow `leads` row → HubSpot contact
 *     properties, scope §3.1, incl. the five custom properties),
 *   - syncLead PATCH mapping when the contact already exists,
 *   - custom-property creation payloads (POST /crm/v3/properties/contacts,
 *     idempotent — 409 "already exists" is treated as success),
 *   - 409 version-conflict refetch → re-apply → retry-once behavior,
 *   - updateLeadStatus (PATCH hs_lead_status),
 *   - batch read/upsert + company search/create + contact→company association,
 *   - not-configured error when no key (health §40 stays correct),
 *   - mock remains the default (CRM_PROVIDER unset → MockCrmProvider; the
 *     registry resolves CRM_PROVIDER=hubspot → name "hubspot").
 *
 * Hermetic: no DATABASE_URL needed (no DB touched), no real keys, no network.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && bun run hubspot-test.ts
 */
import type { CrmLead } from "./src/server/integrations/types";
import { env } from "./src/server/env";
import { getCrmProvider } from "./src/server/integrations";
import { MockCrmProvider } from "./src/server/integrations/crm";
import {
  HubSpotClient,
  HubSpotCrmProvider,
  lfContactPropertyDefinition,
  LF_CONTACT_PROPERTIES,
  LF_PROPERTY_GROUP,
} from "./src/server/integrations/hubspot";

let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}

function assertEq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  pass(label, a === e, `expected ${e}, got ${a}`);
}

// ---------------------------------------------------------------------------
// Fake fetch — records calls, serves canned responses per URL.
// ---------------------------------------------------------------------------

interface FakeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(handler: (call: FakeCall) => { status: number; json?: unknown; text?: string }): typeof fetch & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method) ?? "GET").toUpperCase();
    let body: unknown;
    if (init?.body !== undefined) {
      const raw = typeof init.body === "string" ? init.body : String(init.body);
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    const call: FakeCall = { method, url, headers, body };
    calls.push(call);
    const r = handler(call);
    return new Response(r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : ""), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch & { calls: FakeCall[] };
  fn.calls = calls;
  return fn;
}

const API_KEY = "pat-test-123";

/** Full LeadFlow lead fixture (all fields scope §3.1 maps). */
const lead: CrmLead = {
  id: "lf-lead-1",
  firstName: "Dana",
  lastName: "Ortiz",
  phone: "555-0100",
  email: "dana@example.com",
  serviceRequested: "Furnace Installation",
  status: "appointment_booked",
  score: "warm",
  scoreValue: 87,
  classification: "HOT",
  optedOut: 1,
  location: "Fort Wayne",
};

/** Expected HubSpot contact properties for the fixture (scope §3.1 mapping). */
const expectedProps = {
  email: "dana@example.com",
  firstname: "Dana",
  lastname: "Ortiz",
  phone: "555-0100",
  hs_lead_status: "OPEN_DEAL",
  lf_lead_score: "87",
  lf_classification: "HOT",
  lf_opted_out: "1",
  lf_service_requested: "Furnace Installation",
  lf_location: "Fort Wayne",
};

// --- T1: auth header on every request --------------------------------------
{
  const fetchImpl = fakeFetch(() => ({ status: 200, json: { results: [] } }));
  const client = new HubSpotClient({ apiKey: API_KEY, fetchImpl });
  await client.searchContactsByEmail("nobody@example.com");
  const call = fetchImpl.calls[0];
  pass("T1 authorization header (Bearer)", call.headers.authorization === `Bearer ${API_KEY}`, JSON.stringify(call.headers));
  pass("T1 content-type json", (call.headers["content-type"] ?? "").includes("application/json"));
}

// --- T2: search by email — THE dedupe primitive ----------------------------
{
  const fetchImpl = fakeFetch((call) => {
    if (call.url.endsWith("/crm/v3/objects/contacts/search")) {
      return { status: 200, json: { results: call.body && (call.body as { filterGroups?: unknown[] }).filterGroups ? [] : [] } };
    }
    return { status: 200, json: {} };
  });
  const client = new HubSpotClient({ apiKey: API_KEY, fetchImpl });

  const none = await client.searchContactsByEmail("missing@example.com");
  pass("T2 search empty → null", none === null);

  const fetchHit = fakeFetch(() => ({ status: 200, json: { results: [{ id: "55", properties: { email: "dana@example.com" } }] } }));
  const clientHit = new HubSpotClient({ apiKey: API_KEY, fetchImpl: fetchHit });
  const hit = await clientHit.searchContactsByEmail("dana@example.com");
  pass("T2 search hit → contact", hit?.id === "55", JSON.stringify(hit));
  const searchCall = fetchHit.calls[0];
  pass("T2 search URL + method", searchCall.method === "POST" && searchCall.url === "https://api.hubapi.com/crm/v3/objects/contacts/search", `${searchCall.method} ${searchCall.url}`);
  const searchBody = searchCall.body as { filterGroups: { filters: { propertyName: string; operator: string; value: string } }[]; limit: number };
  pass(
    "T2 search body filters email EQ with limit 1",
    searchBody.filterGroups[0].filters[0].propertyName === "email" &&
      searchBody.filterGroups[0].filters[0].operator === "EQ" &&
      searchBody.filterGroups[0].filters[0].value === "dana@example.com" &&
      searchBody.limit === 1
  );
}

// --- T3: syncLead CREATE mapping (no existing contact) ----------------------
{
  const fetchImpl = fakeFetch((call) => {
    if (call.url.endsWith("/crm/v3/objects/contacts/search")) return { status: 200, json: { results: [] } };
    return { status: 200, json: { id: "1001", properties: {} } };
  });
  const provider = new HubSpotCrmProvider({ apiKey: API_KEY, fetchImpl });
  const res = await provider.syncLead(lead);
  pass("T3 syncLead create returns externalId", res.externalId === "1001", JSON.stringify(res));
  pass("T3 dedupes via search first", fetchImpl.calls[0].url.endsWith("/contacts/search"));
  const create = fetchImpl.calls[1];
  pass("T3 creates via POST /crm/v3/objects/contacts", create.method === "POST" && create.url === "https://api.hubapi.com/crm/v3/objects/contacts", `${create.method} ${create.url}`);
  const createBody = (create.body as { properties: Record<string, unknown> }).properties;
  assertEq("T3 create property mapping (§3.1 incl. custom props)", createBody, expectedProps);
  pass("T3 create carries Bearer auth", create.headers.authorization === `Bearer ${API_KEY}`);
}

// --- T4: syncLead PATCH mapping (existing contact) --------------------------
{
  const fetchImpl = fakeFetch((call) => {
    if (call.url.endsWith("/crm/v3/objects/contacts/search")) {
      return { status: 200, json: { results: [{ id: "1001", properties: { email: "dana@example.com" } }] } };
    }
    if (call.method === "PATCH" && call.url.endsWith("/crm/v3/objects/contacts/1001")) return { status: 200, json: { id: "1001" } };
    return { status: 200, json: {} };
  });
  const provider = new HubSpotCrmProvider({ apiKey: API_KEY, fetchImpl });
  const res = await provider.syncLead(lead);
  pass("T4 syncLead update returns existing externalId", res.externalId === "1001", JSON.stringify(res));
  const patch = fetchImpl.calls[1];
  pass("T4 PATCHes /crm/v3/objects/contacts/1001", patch.method === "PATCH" && patch.url.endsWith("/crm/v3/objects/contacts/1001"), `${patch.method} ${patch.url}`);
  const patchBody = (patch.body as { properties: Record<string, unknown> }).properties;
  assertEq("T4 PATCH property mapping (§3.1 incl. custom props)", patchBody, expectedProps);
}

// --- T5: custom-property creation payloads (idempotent) ---------------------
{
  const payloads: unknown[] = [];
  const fetchImpl = fakeFetch((call) => {
    if (call.url.endsWith("/crm/v3/properties/contacts/groups")) {
      return { status: 201, json: { name: "leadflow_ai", label: "LeadFlow AI" } };
    }
    if (call.url.endsWith("/crm/v3/properties/contacts")) {
      payloads.push(call.body);
      return { status: 201, json: { name: (call.body as { name: string }).name } };
    }
    return { status: 200, json: {} };
  });
  const client = new HubSpotClient({ apiKey: API_KEY, fetchImpl });
  const ensured = await client.ensureContactProperties();
  const names = Object.keys(LF_CONTACT_PROPERTIES);
  pass(
    "T5 group created first, then all custom properties",
    ensured[0] === "group:leadflow_ai" && payloads.length === names.length && ensured.length === names.length + 1,
    `ensured=${ensured.join(",")}`
  );
  assertEq("T5 payload names", (payloads as { name: string }[]).map((p) => p.name).sort(), names.sort());
  pass("T5 every payload uses the leadflow_ai group", (payloads as { groupName: string }[]).every((p) => p.groupName === LF_PROPERTY_GROUP));
  const byName = Object.fromEntries((payloads as { name: string; type: string; fieldType: string }[]).map((p) => [p.name, p]));
  pass("T5 lf_lead_score is a number", byName.lf_lead_score?.type === "number" && byName.lf_lead_score?.fieldType === "number");
  pass(
    "T5 classification/opted_out/service/location/import are text",
    ["lf_classification", "lf_opted_out", "lf_service_requested", "lf_location", "lf_import_key", "lf_source_file"].every((n) => byName[n]?.type === "string")
  );

  // 409 "already exists" → treated as success (idempotent re-run).
  const fetch409 = fakeFetch(() => ({ status: 409, json: { status: "error", message: "Property already exists." } }));
  const client409 = new HubSpotClient({ apiKey: API_KEY, fetchImpl: fetch409 });
  const reEnsured = await client409.ensureContactProperties();
  pass("T5 409 already-exists is not a failure", reEnsured.length === 0, `calls=${fetch409.calls.length}`);
  pass("T5 group 409 is not a failure either", fetch409.calls[0].url.endsWith("/groups"));
}

// --- T6: 409 version-conflict → refetch → re-apply → retry once -------------
{
  let patchCount = 0;
  const fetchImpl = fakeFetch((call) => {
    if (call.url.endsWith("/crm/v3/objects/contacts/search")) {
      return { status: 200, json: { results: [{ id: "1001" }] } };
    }
    if (call.method === "PATCH" && call.url.endsWith("/crm/v3/objects/contacts/1001")) {
      patchCount += 1;
      if (patchCount === 1) return { status: 409, json: { status: "error", message: "This contact was modified concurrently." } };
      return { status: 200, json: { id: "1001" } };
    }
    if (call.method === "GET" && call.url.endsWith("/crm/v3/objects/contacts/1001")) {
      return { status: 200, json: { id: "1001", version: 7, properties: { email: "dana@example.com" } } };
    }
    return { status: 200, json: {} };
  });
  const provider = new HubSpotCrmProvider({ apiKey: API_KEY, fetchImpl });
  const res = await provider.syncLead(lead);
  pass("T6 409 retry succeeds (externalId kept)", res.externalId === "1001", JSON.stringify(res));
  pass("T6 call sequence = search, PATCH(409), GET refetch, PATCH(ok)", fetchImpl.calls.length === 4, `calls=${fetchImpl.calls.map((c) => `${c.method} ${c.url.split("/").slice(-2).join("/")}`).join(" → ")}`);
  pass("T6 first PATCH returns 409 (concurrent modification)", patchCount === 2);
  const retry = fetchImpl.calls[3] as { method: string; body: { properties: Record<string, unknown>; version?: number } };
  pass("T6 refetch happened before retry (GET call present)", fetchImpl.calls[2].method === "GET" && fetchImpl.calls[2].url.endsWith("/contacts/1001"));
  pass("T6 retry PATCH carries the fresh version", retry.body.version === 7, `version=${retry.body.version}`);
  assertEq("T6 retry re-applies the full property mapping", retry.body.properties, expectedProps);
}

// --- T7: updateLeadStatus ----------------------------------------------------
{
  const fetchImpl = fakeFetch((call) => {
    if (call.method === "PATCH" && call.url.endsWith("/crm/v3/objects/contacts/1001")) return { status: 200, json: { id: "1001" } };
    return { status: 200, json: {} };
  });
  const provider = new HubSpotCrmProvider({ apiKey: API_KEY, fetchImpl });
  await provider.updateLeadStatus("1001", "new");
  const patch = fetchImpl.calls[0];
  pass("T7 updateLeadStatus PATCHes hs_lead_status only", patch.method === "PATCH", `${patch.method} ${patch.url}`);
  const body = (patch.body as { properties: Record<string, unknown> }).properties;
  assertEq("T7 status mapping new → NEW", body, { hs_lead_status: "NEW" });
}

// --- T8: not configured (no key) → clear error -------------------------------
{
  const bare = new HubSpotClient({ apiKey: "" });
  let threw = "";
  try {
    await bare.searchContactsByEmail("x@example.com");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  pass("T8 client without key throws not-configured", /not configured/.test(threw), threw);

  const provider = new HubSpotCrmProvider({ apiKey: "" });
  let threw2 = "";
  try {
    await provider.syncLead(lead);
  } catch (e) {
    threw2 = e instanceof Error ? e.message : String(e);
  }
  pass("T8 provider without key throws not-configured", /not configured/.test(threw2), threw2);
}

// --- T9: batch read/upsert + company search/create + association ------------
{
  const fetchImpl = fakeFetch((call) => {
    if (call.url.endsWith("/crm/v3/objects/contacts/batch/read")) return { status: 200, json: { results: [{ id: "1001" }] } };
    if (call.url.endsWith("/crm/v3/objects/contacts/batch/upsert")) return { status: 200, json: { results: [{ id: "1002" }] } };
    if (call.url.endsWith("/crm/v3/objects/companies/search")) return { status: 200, json: { results: [{ id: "3001", properties: { domain: "smithhvac.com" } }] } };
    if (call.method === "POST" && call.url.endsWith("/crm/v3/objects/companies")) return { status: 201, json: { id: "3001" } };
    if (call.url.includes("/crm/v3/objects/contacts/1001/associations/companies/3001")) return { status: 204, text: "" };
    return { status: 200, json: {} };
  });
  const client = new HubSpotClient({ apiKey: API_KEY, fetchImpl });

  const read = await client.batchReadContactsByEmail(["dana@example.com"]);
  const readBody = fetchImpl.calls[0].body as { inputs: { id: string }[]; idProperty: string };
  pass("T9 batch read by email (idProperty=email)", read[0].id === "1001" && readBody.idProperty === "email" && readBody.inputs[0].id === "dana@example.com");

  const upserted = await client.batchUpsertContacts([{ email: "dana@example.com", properties: expectedProps }]);
  const upsertBody = fetchImpl.calls[1].body as { inputs: { id: string; properties: Record<string, unknown> }[]; idProperty: string };
  pass("T9 batch upsert keyed by email", upserted[0].id === "1002" && upsertBody.idProperty === "email" && upsertBody.inputs[0].id === "dana@example.com");
  assertEq("T9 batch upsert carries the §3.1 mapping", upsertBody.inputs[0].properties, expectedProps);

  const company = await client.searchCompaniesByDomain("smithhvac.com");
  pass("T9 company search by domain", company?.id === "3001");

  const created = await client.createCompany({ name: "Smith's HVAC", domain: "smithhvac.com" });
  const companyCreate = fetchImpl.calls[3];
  pass("T9 create company POST", created.id === "3001" && companyCreate.url.endsWith("/crm/v3/objects/companies"));

  await client.associateContactToCompany("1001", "3001");
  const assoc = fetchImpl.calls[4];
  pass("T9 associate contact→company via PUT", assoc.method === "PUT" && assoc.url.includes("/contacts/1001/associations/companies/3001"), `${assoc.method} ${assoc.url}`);
}

// --- T10: mock remains the default (no CRM_PROVIDER) --------------------------
{
  delete process.env.CRM_PROVIDER;
  pass("T10 CRM_PROVIDER defaults to mock", env.crmProvider === "mock", `got "${env.crmProvider}"`);
  const provider = getCrmProvider();
  pass("T10 getCrmProvider() → MockCrmProvider by default", provider instanceof MockCrmProvider, `got ${provider.name}`);
}

// --- T11: registry resolves CRM_PROVIDER=hubspot ------------------------------
{
  // Fresh process (the singleton `_crm` is process-scoped) — proves the
  // `hubspot` registry entry is wired end-to-end.
  const script = `
process.env.CRM_PROVIDER = "hubspot";
import("./src/server/integrations/index.ts").then((m) => { console.log(m.getCrmProvider().name); });
`;
  const out = Bun.spawnSync({
    cmd: ["bun", "-e", script],
    cwd: process.cwd(),
    env: { ...process.env, CRM_PROVIDER: "hubspot" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Buffer.from(out.stdout ?? "").toString().trim();
  const stderr = Buffer.from(out.stderr ?? "").toString().trim();
  pass("T11 CRM_PROVIDER=hubspot → provider name 'hubspot'", out.exitCode === 0 && stdout === "hubspot", `exit=${out.exitCode} out="${stdout}" err="${stderr.slice(0, 160)}"`);
}

// --- T12: backfill-import helpers (Phase 1 task 4) --------------------------
{
  const fetchImpl = fakeFetch((call) => {
    if (call.url.includes("/crm/v3/objects/contacts?") || call.url.includes("/crm/v3/objects/companies?")) {
      return { status: 200, json: { results: [{ id: "1" }], paging: { next: { after: "2" } } } };
    }
    if (call.url.includes("/companies/search")) return { status: 200, json: { results: [{ id: "3001", properties: { name: "Pest Patrol", domain: "pestpatrol.com" } }] } };
    if (call.url.includes("/companies/batch/read")) return { status: 200, json: { results: [{ id: "3001", properties: { domain: "pestpatrol.com" } }] } };
    if (call.url.includes("/contacts/batch/create")) return { status: 201, json: { results: [{ id: "1003" }] } };
    if (call.url.includes("/companies/batch/create")) return { status: 201, json: { results: [{ id: "3002" }] } };
    if (call.method === "PATCH" && call.url.includes("/companies/")) return { status: 200, json: { id: "3001" } };
    if (call.url.includes("/contacts/search")) return { status: 200, json: { results: [{ id: "1004", properties: { lf_import_key: "x" } }] } };
    return { status: 200, json: {} };
  });
  const client = new HubSpotClient({ apiKey: API_KEY, fetchImpl });

  const c1 = await client.listObjects(`/crm/v3/objects/contacts?limit=100&properties=email`);
  pass("T12 listObjects pages and returns paging cursor", c1.results.length === 1 && c1.paging?.next?.after === "2");

  const byName = await client.searchCompaniesByName("Pest Patrol");
  pass("T12 searchCompaniesByName returns company", byName?.id === "3001");

  const read = await client.batchReadCompaniesByIds(["3001"]);
  pass("T12 batchReadCompaniesByIds", read[0]?.id === "3001");

  const created = await client.batchCreateContacts([{ properties: { email: "x@example.com" } }]);
  pass("T12 batchCreateContacts", created[0]?.id === "1003");

  const co = await client.batchCreateCompanies([{ properties: { name: "Pest Patrol" } }]);
  pass("T12 batchCreateCompanies", co[0]?.id === "3002");

  const upd = await client.updateCompany("3001", { domain: "pestpatrol.com" });
  const patch = fetchImpl.calls.find((c) => c.method === "PATCH" && c.url.includes("/companies/3001"));
  pass("T12 updateCompany PATCHes the company", upd?.id === "3001" && patch !== undefined);
  const patchBody = (patch?.body as { properties: Record<string, unknown> }).properties;
  assertEq("T12 updateCompany maps domain", patchBody, { domain: "pestpatrol.com" });

  const byProp = await client.searchContactsByProperty("lf_import_key", "name");
  pass("T12 searchContactsByProperty", byProp?.id === "1004");
  const searchBody = fetchImpl.calls.find((c) => c.url.endsWith("/contacts/search"))?.body as { filterGroups: { filters: { propertyName: string; operator: string; value: string }[] }[] };
  pass(
    "T12 searchContactsByProperty filters lf_import_key EQ",
    searchBody?.filterGroups?.[0]?.filters?.[0]?.propertyName === "lf_import_key" && searchBody.filterGroups[0].filters[0].value === "name"
  );
}

console.log(failures === 0 ? "\nALL HUBSPOT TESTS PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);