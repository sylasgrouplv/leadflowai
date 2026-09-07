/**
 * HubSpot ↔ ctomail two-way sync (Phase 1 task 2) — hermetic tests.
 *
 * Verifies, WITHOUT network or real keys:
 *   1. sync_state read/write round-trip (insert + update + unique triple),
 *   2. meta-JSON merge semantics on the cursor row,
 *   3. the config gate: CRM_PROVIDER≠hubspot → skipped='not_configured'
 *      (no DB writes, no network); CRM_PROVIDER=hubspot + key → a run
 *      attempt; missing key only → also a graceful skip,
 *   4. the inbound mapper (HubSpot contact → local lead plan, §3.1
 *      fields + status reverse-map; no-email rows are skipped),
 *   5. the outbound property mapper (lead row → HubSpot contact props),
 *   6. a full runHubSpotSync() pass against a FAKE HubSpotClient (canned
 *      search/batch results): creates the local lead from HubSpot, pushes
 *      the local delta out through batchUpsertContacts, advances both
 *      cursors, and a second run with unchanged data is a no-op (created=0,
 *      pushed=0) — the idempotency proof,
 *   7. status/error bookkeeping on a failing direction.
 *
 * Hermetic: SQLite (no DATABASE_URL), no real keys, no network — the fake
 * client is injected through runHubSpotSync's opts (resolveSyncConfig honors
 * an explicit key, and the client is swapped at the pull/push boundary by
 * the run's own config; for the canned pass we drive pull/push directly).
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run hubspot-sync-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "./src/server/auth/password";
import * as repo from "./src/server/db/repo";
import {
  getSyncState,
  upsertSyncState,
  resolveSyncConfig,
  mapHubSpotContactToInbound,
  runHubSpotSync,
  pullHubSpotContacts,
  pushLeadsToHubSpot,
  leadToProperties,
  HUBSPOT_SYNC_PROVIDER,
} from "./src/server/crm/sync";
import type { HubSpotClient } from "./src/server/integrations/hubspot";
import type { HubSpotObject, HubSpotSearchResult } from "./src/server/integrations/hubspot";

process.env.DATABASE_PATH = ".data/hubspot-sync-test.db";
runMigrations();

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

const db = getDb();
const T0 = 1_700_000_000_000;

function hsContact(overrides: Record<string, string>, id = "801"): HubSpotObject {
  return {
    id,
    properties: {
      email: "",
      firstname: "",
      lastname: "",
      phone: "",
      hs_lead_status: "",
      lf_lead_score: "",
      lf_classification: "",
      lf_opted_out: "0",
      lf_service_requested: "",
      lf_location: "",
      hs_lastmodifieddate: String(T0 + 1),
      ...overrides,
    },
  };
}

/** Minimal HubSpotClient double: canned search page + batch-upsert capture. */
function fakeClient(page: HubSpotObject[]) {
  const upserts: { email: string; properties: Record<string, string> }[][] = [];
  const client = {
    searchContacts: async () =>
      ({
        results: page,
        total: page.length,
        paging: {},
      }) as unknown as HubSpotSearchResult,
    batchUpsertContacts: async (inputs: { email: string; properties: Record<string, string> }[]) => {
      upserts.push(inputs);
      return inputs.map((i, idx) => ({ id: String(9000 + idx), properties: i.properties }));
    },
  };
  return { client: client as unknown as HubSpotClient, upserts };
}

(async () => {
  // ---- 0. Tenant fixture (own business, so the dogfood tenant on a real
  // dev DB is never touched) ------------------------------------------------
  const suffix = Math.random().toString(36).slice(2, 8);
  // NOTE: pull/push file under the business named DOGFOOD_BUSINESS_NAME
  // ("LeadFlow AI"). On this fresh hermetic DB we create exactly that.
  const owner = await repo.createUser({
    email: `sync-test-${suffix}@leadflowai.test`,
    passwordHash: hashPassword("x".repeat(32)),
    name: "Sync Test Owner",
  });
  const biz = await repo.createBusiness({ ownerId: owner!.id, name: "LeadFlow AI" });
  const BIZ_ID = biz!.id;

  // ---- 1. sync_state round-trip ------------------------------------------
  const row1 = await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts", {
    lastSyncAt: T0,
    lastCursor: "1700000000000",
    status: "ok",
    meta: { pulled: 3 },
  });
  pass("sync_state: insert creates a row with the given cursor", row1.lastCursor === "1700000000000" && row1.status === "ok" && row1.lastSyncAt === T0);
  const row2 = await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts", {
    lastCursor: "1700000099999",
    status: "error",
    error: "boom",
    meta: { pushed: 1 },
  });
  pass("sync_state: update mutates the SAME row (unique triple)", row2.id === row1.id && row2.lastCursor === "1700000099999" && row2.status === "error");
  pass("sync_state: meta merges counters across updates", JSON.parse(row2.metaJson).pulled === 3 && JSON.parse(row2.metaJson).pushed === 1);
  const fetched = await getSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts");
  pass("sync_state: getSyncState reads the row back", fetched?.id === row1.id);
  pass("sync_state: unknown triple reads null", (await getSyncState("nope", "inbound", "contacts")) === null);
  const all = await db.select().from(s.syncState).where(and(eq(s.syncState.provider, HUBSPOT_SYNC_PROVIDER), eq(s.syncState.direction, "inbound"), eq(s.syncState.entity, "contacts"))).execute();
  assertEq("sync_state: exactly one row per (provider, direction, entity)", all.length, 1);

  // ---- 2. config gate -----------------------------------------------------
  delete process.env.CRM_PROVIDER;
  delete process.env.HUBSPOT_API_KEY;
  const cfgDefault = resolveSyncConfig();
  pass("gate: default (mock CRM) does not resolve", cfgDefault.ok === false && cfgDefault.client === null);
  const cfgProviderOnly = resolveSyncConfig("", "hubspot");
  pass("gate: CRM_PROVIDER=hubspot with NO key does not resolve", cfgProviderOnly.ok === false && /HUBSPOT_API_KEY/.test(cfgProviderOnly.reason));
  const cfgOk = resolveSyncConfig("test-key", "hubspot");
  pass("gate: provider + key resolve to a client", cfgOk.ok === true && cfgOk.client !== null);
  const skipRun = await runHubSpotSync({ provider: "mock" });
  pass("job: unconfigured run skips gracefully", skipRun.skipped === "not_configured" && skipRun.ok === true && skipRun.inbound === null && skipRun.outbound === null);
  const statesAfterSkip = await db.select().from(s.syncState).execute();
  const testRows = statesAfterSkip.filter((r) => r.id !== row1.id && (r.provider === HUBSPOT_SYNC_PROVIDER));
  assertEq("job: unconfigured run writes no cursor rows", testRows.length, 0);

  // ---- 3. inbound mapper --------------------------------------------------
  const full = mapHubSpotContactToInbound(
    hsContact({
      email: "Jane.Doe@Example.com",
      firstname: "Jane",
      lastname: "Doe",
      phone: "+15551230000",
      hs_lead_status: "OPEN_DEAL",
      lf_classification: "HOT",
      lf_lead_score: "85",
      lf_service_requested: "AC repair",
      lf_location: "Fort Wayne, IN",
      hs_lastmodifieddate: String(T0 + 5000),
    })
  );
  pass("mapper: email is lowercased (dedupe key)", full.email === "jane.doe@example.com");
  pass("mapper: names/phone/service/location map 1:1", full.firstName === "Jane" && full.lastName === "Doe" && full.phone === "+15551230000" && full.serviceRequested === "AC repair" && full.location === "Fort Wayne, IN");
  pass("mapper: hs_lead_status OPEN_DEAL → appointment_booked", full.status === "appointment_booked");
  pass("mapper: lf_lead_score parses to a number", full.scoreValue === 85);
  pass("mapper: lf_classification passes through", full.classification === "HOT");
  const noEmail = mapHubSpotContactToInbound(hsContact({ email: "" }));
  pass("mapper: no-email contact is skipped (no dedupe key)", noEmail.ok === false && noEmail.skipReason.length > 0);
  const unknownStatus = mapHubSpotContactToInbound(hsContact({ email: "x@y.test", hs_lead_status: "", lf_classification: "UNQUALIFIED" }));
  pass("mapper: UNQUALIFIED classification → unqualified status fallback", unknownStatus.status === "unqualified");

  // ---- 4. outbound property mapper ---------------------------------------
  const pushedLead = {
    id: "lead-1",
    businessId: BIZ_ID,
    firstName: "Jane",
    lastName: "Doe",
    phone: "+15551230000",
    email: "jane.doe@example.com",
    source: "website_chat",
    serviceRequested: "AC repair",
    location: "Fort Wayne, IN",
    status: "appointment_booked",
    score: "hot",
    scoreValue: 85,
    classification: "HOT",
    notes: "",
    assignedTo: null,
    estimatedValueCents: 0,
    lastContactedAt: null,
    optedOut: 0,
    optOutChannel: "",
    createdAt: T0,
    updatedAt: T0,
  };
  await pullHubSpotContacts; await pushLeadsToHubSpot; // keep imports explicit
  const props = leadToProperties(pushedLead as never);
  pass("outbound props: §3.1 fields present", props.email === "jane.doe@example.com" && props.firstname === "Jane" && props.lastname === "Doe" && props.phone === "+15551230000" && props.lf_service_requested === "AC repair" && props.lf_location === "Fort Wayne, IN");
  pass("outbound props: lf_lead_score + classification + hs_lead_status", props.lf_lead_score === "85" && props.lf_classification === "HOT" && props.hs_lead_status === "OPEN_DEAL");
  pass("outbound props: lf_opted_out=0 when not opted out", props.lf_opted_out === "0");

  // ---- 5. full run against the fake client -------------------------------
  // Cursor rows from earlier steps exist; reset them for a clean window.
  await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts", { lastCursor: null, status: "idle", error: null });
  await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "outbound", "contacts", { lastCursor: null, status: "idle", error: null });

  // Outbound delta: one local lead newer than the (null → 7d backstop) cursor.
  const t = Date.now();
  const localLead = await repo.createLead({
    businessId: BIZ_ID,
    firstName: "Out",
    lastName: "Bound",
    email: `out-bound-${suffix}@example.test`,
    phone: "+15559990000",
    serviceRequested: "Furnace install",
    location: "Adrian, MI",
    status: "new",
    score: "cold",
    createdAt: t,
  });
  await db.update(s.leads).set({ updatedAt: t + 10 }).where(eq(s.leads.id, localLead!.id)).execute();

  const { client, upserts } = fakeClient([
    hsContact(
      {
        email: "jane.doe@example.com",
        firstname: "Jane",
        lastname: "Doe",
        phone: "+15551230000",
        hs_lead_status: "NEW",
        lf_classification: "WARM",
        lf_lead_score: "55",
        lf_service_requested: "AC tune-up",
        lf_location: "Fort Wayne, IN",
        hs_lastmodifieddate: String(Date.now() - 1000),
      },
      "802"
    ),
  ]);
  const run1 = await runHubSpotSync({ apiKey: "test-key", provider: "hubspot", clientOverride: client });
  pass("run1: executes both directions", run1.ok === true && run1.skipped === "" && run1.inbound !== null && run1.outbound !== null);
  pass("run1: inbound creates the HubSpot contact locally", run1.inbound!.created === 1 && run1.inbound!.pulled === 1 && run1.inbound!.skipped === 0 && run1.inbound!.errors === 0);
  const inboundRow = await db.select().from(s.leads).where(and(eq(s.leads.businessId, BIZ_ID), eq(s.leads.email, "jane.doe@example.com"))).execute();
  pass("run1: inbound row has §3.1 values + source=hubspot_sync", inboundRow.length === 1 && inboundRow[0].firstName === "Jane" && inboundRow[0].source === "hubspot_sync" && inboundRow[0].status === "new" && inboundRow[0].scoreValue === 55);
  pass("run1: outbound pushes the local delta through batchUpsertContacts", run1.outbound!.pushed === 1 && upserts.length === 1 && upserts[0][0].email === `out-bound-${suffix}@example.test`);
  const inStateAfter = await getSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts");
  const outStateAfter = await getSyncState(HUBSPOT_SYNC_PROVIDER, "outbound", "contacts");
  pass("run1: inbound cursor advanced to the newest hs_lastmodifieddate", inStateAfter?.status === "ok" && inStateAfter?.lastCursor !== null && Number(inStateAfter?.lastCursor) >= Date.now() - 2000 && Number(inStateAfter?.lastCursor) <= Date.now());
  pass("run1: outbound cursor advanced + status ok", outStateAfter?.status === "ok" && outStateAfter?.lastCursor !== null);

  // ---- 6. idempotency: second run over unchanged data is a no-op ---------
  const run2 = await runHubSpotSync({ apiKey: "test-key", provider: "hubspot", clientOverride: client });
  pass("run2: inbound re-pulls the same window (cursor-based search is fake-static) but creates nothing", run2.inbound!.created === 0 && run2.inbound!.updated === 0);
  pass("run2: outbound finds nothing newer than the watermark", run2.outbound!.pushed === 0 && run2.outbound!.skipped === 0);
  const leadCount = await db.select().from(s.leads).where(eq(s.leads.businessId, BIZ_ID)).execute();
  assertEq("run2: no duplicate lead rows", leadCount.length, 2);

  // ---- 7. failure bookkeeping --------------------------------------------
  const failing = {
    searchContacts: async () => {
      throw new Error("portal down");
    },
    batchUpsertContacts: async () => {
      throw new Error("portal down");
    },
  } as unknown as HubSpotClient;
  // Fresh cursors so both directions actually attempt their work.
  await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts", { lastCursor: null, status: "idle" });
  await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "outbound", "contacts", { lastCursor: null, status: "idle" });
  const run3 = await runHubSpotSync({ apiKey: "test-key", provider: "hubspot", clientOverride: failing });
  pass("run3: failing directions report ok=false + errors", run3.ok === false && run3.errors >= 2);
  const inErr = await getSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts");
  const outErr = await getSyncState(HUBSPOT_SYNC_PROVIDER, "outbound", "contacts");
  pass("run3: status=error + message persisted on both directions", inErr?.status === "error" && (inErr?.error ?? "").includes("portal down") && outErr?.status === "error" && (outErr?.error ?? "").includes("portal down"));
  pass("run3: cursors NOT advanced on failure (retry next run)", inErr?.lastCursor === null && outErr?.lastCursor === null);

  // ---- cleanup ------------------------------------------------------------
  for (const l of await db.select().from(s.leads).where(eq(s.leads.businessId, BIZ_ID)).execute()) await db.delete(s.leads).where(eq(s.leads.id, l.id)).execute();
  for (const i of await db.select().from(s.integrations).where(eq(s.integrations.businessId, BIZ_ID)).execute()) await db.delete(s.integrations).where(eq(s.integrations.id, i.id)).execute();
  for (const sub of await db.select().from(s.subscriptions).where(eq(s.subscriptions.businessId, BIZ_ID)).execute()) await db.delete(s.subscriptions).where(eq(s.subscriptions.id, sub.id)).execute();
  await db.delete(s.teamMembers).where(eq(s.teamMembers.businessId, BIZ_ID)).execute();
  await db.delete(s.businesses).where(eq(s.businesses.id, BIZ_ID)).execute();
  await db.delete(s.users).where(eq(s.users.id, owner!.id)).execute();
  await db.delete(s.syncState).where(eq(s.syncState.provider, HUBSPOT_SYNC_PROVIDER)).execute();

  console.log(failures === 0 ? "\nALL TESTS PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
