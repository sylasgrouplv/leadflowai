/**
 * HubSpot webhook receiver (Phase 1 task 3) — hermetic tests.
 *
 * Verifies, WITHOUT network or real keys (SQLite, fake HubSpotClient):
 *   1. signature verify: correct / wrong / tampered-body / missing-secret /
 *      missing-signature-with-secret,
 *   2. GET verification path: ?token= echoed back; no token → info JSON,
 *   3. event parsing + shared-pipeline reuse: creation creates the lead via
 *      the SAME mapHubSpotContactToInbound/upsertInboundPlan path the poller
 *      uses; propertyChange updates it; unknown subscription types skip,
 *   4. idempotent replay: same eventId twice → second is a duplicate no-op
 *      (no second write, no second fetch),
 *   5. unconfigured behavior: resolveSyncConfig with CRM_PROVIDER=mock or no
 *      key → not ok (the route answers 200-skipped without DB writes),
 *   6. deletion handling: contact.deletion flags (optedOut=1, channel "all",
 *      notes marker) — never hard-deletes; unknown email → skipped,
 *   7. company events acknowledged + skipped (contacts-only scope),
 *   8. inbound last_sync_at refreshed while last_cursor is untouched.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run hubspot-webhook-test.ts
 */
import { createHash } from "node:crypto";
// NOTE: DATABASE_PATH must be set BEFORE the db client module (or any module
// that imports it) is first evaluated — static imports below bind the client
// at load time. Keep this assignment above all src/server imports.
process.env.DATABASE_PATH = "/tmp/hubspot-webhook-test.db";
import { runMigrations } from "./src/server/db/migrate";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { eq } from "drizzle-orm";
import { hashPassword } from "./src/server/auth/password";
import * as repo from "./src/server/db/repo";
import { createApp } from "./src/server/index";
import {
  getSyncState,
  upsertSyncState,
  resolveSyncConfig,
  mapHubSpotContactToInbound,
  upsertInboundPlan,
  HUBSPOT_SYNC_PROVIDER,
} from "./src/server/crm/sync";
import {
  verifyHubSpotSignature,
  processHubSpotWebhookEvents,
  recordWebhookEventIds,
} from "./src/server/crm/webhooks";
import type { HubSpotClient, HubSpotObject } from "./src/server/integrations/hubspot";

// (DATABASE_PATH was set at the top of the file, before the db imports.)
// Route-level tests below drive processHubSpotWebhookEvents directly (the app
// factory's hubspotClient override is not part of the route contract); force
// the unconfigured path through resolveSyncConfig instead of HTTP for #5, and
// exercise the HTTP signature + GET paths against the real Hono app.
delete process.env.HUBSPOT_API_KEY;
delete process.env.Hubspot_API_key;
process.env.CRM_PROVIDER = "mock";
delete process.env.HUBSPOT_WEBHOOK_SECRET;
delete process.env.HUBSPOT_APP_SECRET;
await runMigrations();

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
const sign = (secret: string, body: string) => createHash("sha256").update(secret + body, "utf8").digest("hex");

// ---- 0. fixture ------------------------------------------------------------
const suffix = Math.random().toString(36).slice(2, 8);
const owner = await repo.createUser({
  email: `webhook-test-${suffix}@leadflowai.test`,
  passwordHash: hashPassword("x".repeat(32)),
  name: "Webhook Test Owner",
});
const biz = await repo.createBusiness({ ownerId: owner!.id, name: "LeadFlow AI" });
const BIZ_ID = biz!.id;

function hsContact(email: string, id = "901", overrides: Record<string, string> = {}): HubSpotObject {
  return {
    id,
    properties: {
      email,
      firstname: "Ada",
      lastname: "Lovelace",
      phone: "260-555-0100",
      hs_lead_status: "NEW",
      lf_lead_score: "82",
      lf_classification: "HOT",
      lf_opted_out: "0",
      lf_service_requested: "AC repair",
      lf_location: "Fort Wayne",
      hs_lastmodifieddate: String(Date.now()),
      ...overrides,
    },
  };
}

/** Fake HubSpotClient: canned getContact map + fetch counter. */
function fakeClient(byId: Record<string, HubSpotObject>) {
  let fetches = 0;
  const client = {
    getContact: async (id: string) => {
      fetches += 1;
      const c = byId[id];
      if (!c) {
        const err = new Error("HubSpot API error 404: not found") as Error & { status: number; body: string };
        (err as unknown as Record<string, unknown>).status = 404;
        Object.setPrototypeOf(err, Object.getPrototypeOf(new (await import("./src/server/integrations/hubspot")).HubSpotApiError(404, "not found")));
        throw err;
      }
      return c;
    },
  };
  return { client: client as unknown as HubSpotClient, get fetches() { return fetches; } };
}

// ---- 1. signature verify ----------------------------------------------------
{
  const body = JSON.stringify([{ eventId: 1 }]);
  const secret = "s3cr3t";
  pass("sig: correct signature verifies", verifyHubSpotSignature(body, sign(secret, body), secret));
  pass("sig: wrong signature rejected", !verifyHubSpotSignature(body, sign("other", body), secret));
  pass("sig: tampered body rejected", !verifyHubSpotSignature(body + "x", sign(secret, body), secret));
  pass("sig: missing secret accepts (dev/dogfood default)", verifyHubSpotSignature(body, "anything", ""));
  pass("sig: secret set + missing signature rejected", !verifyHubSpotSignature(body, "", secret));
}

// ---- 2. GET verification path ----------------------------------------------
{
  const app = await createApp();
  const withToken = await app.request("/api/webhooks/hubspot?token=abc123");
  assertEq("GET ?token= echoes the token", await withToken.text(), "abc123");
  const noToken = await app.request("/api/webhooks/hubspot");
  const noTokenJson = (await noToken.json()) as Record<string, unknown>;
  pass("GET without token returns endpoint info (200)", noToken.status === 200 && noTokenJson.ok === true);
}

// ---- 3. creation + propertyChange via the shared pipeline -------------------
{
  const contact = hsContact(`wh-create-${suffix}@example.com`, "911");
  const { client } = fakeClient({ "911": contact });
  // Prove pipeline reuse: the receiver's write equals the poller's mapper output.
  const plan = mapHubSpotContactToInbound(contact);
  pass("mapper reuse: plan ok + hotspot fields", plan.ok && plan.email.includes("wh-create-") && plan.classification === "HOT" && plan.scoreValue === 82);

  const r1 = await processHubSpotWebhookEvents(client, [
    { eventId: 1001, subscriptionType: "contact.creation", objectId: 911, occurredAt: Date.now(), attemptNumber: 0 },
  ]);
  assertEq("creation: created=1 processed=1", [r1.created, r1.processed, r1.errors], [1, 1, 0]);
  const lead = (await db.select().from(s.leads).where(eq(s.leads.email, plan.email)).execute())[0];
  pass("creation: lead row exists under dogfood tenant", Boolean(lead) && lead.businessId === BIZ_ID && lead.source === "hubspot_sync");

  const updated = hsContact(plan.email, "911", { phone: "260-555-0199", lf_lead_score: "91" });
  const { client: client2 } = fakeClient({ "911": updated });
  const r2 = await processHubSpotWebhookEvents(client2, [
    { eventId: 1002, subscriptionType: "contact.propertyChange", objectId: 911, propertyName: "phone", propertyValue: "260-555-0199", occurredAt: Date.now(), attemptNumber: 0 },
  ]);
  assertEq("propertyChange: updated=1", [r2.updated, r2.processed], [1, 1]);
  const lead2 = (await db.select().from(s.leads).where(eq(s.leads.email, plan.email)).execute())[0];
  pass("propertyChange: phone + score patched", lead2.phone === "260-555-0199" && lead2.scoreValue === 91);

  // Unknown subscription types skip cleanly.
  const r3 = await processHubSpotWebhookEvents(client2, [
    { eventId: 1003, subscriptionType: "deal.creation", objectId: 555, occurredAt: Date.now(), attemptNumber: 0 },
  ]);
  assertEq("unknown type: skipped=1, no error", [r3.skipped, r3.errors, r3.processed], [1, 0, 0]);
}

// ---- 4. idempotent replay ----------------------------------------------------
{
  const contact = hsContact(`wh-replay-${suffix}@example.com`, "912");
  const f = fakeClient({ "912": contact });
  const ev = { eventId: 2001, subscriptionType: "contact.creation", objectId: 912, occurredAt: Date.now(), attemptNumber: 0 };
  const before = (await db.select().from(s.leads).execute()).length;
  const a = await processHubSpotWebhookEvents(f.client, [ev]);
  const mid = (await db.select().from(s.leads).execute()).length;
  const b = await processHubSpotWebhookEvents(f.client, [{ ...ev, attemptNumber: 2 }]);
  const after = (await db.select().from(s.leads).execute()).length;
  pass("replay: first delivery creates", a.created === 1 && mid === before + 1);
  assertEq("replay: second delivery is a duplicate no-op", [b.duplicates, b.created, b.updated, after], [1, 0, 0, mid]);
  pass("replay: no second HubSpot fetch on duplicate", f.fetches === 1);
}

// ---- 5. unconfigured behavior -------------------------------------------------
{
  const gateMock = resolveSyncConfig(undefined, "mock");
  pass("unconfigured: CRM_PROVIDER=mock → not ok (route 200-skips)", !gateMock.ok);
  const gateNoKey = resolveSyncConfig("", "hubspot");
  pass("unconfigured: hubspot provider without key → not ok (route 200-skips)", !gateNoKey.ok);

  // The HTTP route itself: no key + mock provider → 200 skipped, no DB writes.
  const app = await createApp();
  const leadsBefore = (await db.select().from(s.leads).execute()).length;
  const res = await app.request("/api/webhooks/hubspot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ eventId: 3001, subscriptionType: "contact.creation", objectId: 999 }]),
  });
  const json = (await res.json()) as Record<string, unknown>;
  const leadsAfter = (await db.select().from(s.leads).execute()).length;
  pass("route unconfigured: 200 + skipped=not_configured", res.status === 200 && json.skipped === "not_configured");
  pass("route unconfigured: zero DB writes", leadsAfter === leadsBefore);
}

// ---- 6. deletion handling ------------------------------------------------------
{
  const email = `wh-del-${suffix}@example.com`;
  const contact = hsContact(email, "913");
  const { client } = fakeClient({ "913": contact });
  await processHubSpotWebhookEvents(client, [
    { eventId: 4001, subscriptionType: "contact.creation", objectId: 913, occurredAt: Date.now(), attemptNumber: 0 },
  ]);
  const d = await processHubSpotWebhookEvents(client, [
    { eventId: 4002, subscriptionType: "contact.deletion", objectId: 913, propertyName: "email", propertyValue: email, occurredAt: Date.now(), attemptNumber: 0 },
  ]);
  assertEq("deletion: flagged=1", [d.flagged, d.errors], [1, 0]);
  // Read back scoped EXACTLY like production (getDogfoodBusinessId), not via
  // the fixture BIZ_ID — the receiver resolves the tenant by name.
  const { getDogfoodBusinessId } = await import("./src/server/crm/sync");
  const dogfoodId = await getDogfoodBusinessId();
  const flaggedRows = (await db.select().from(s.leads).where(eq(s.leads.email, email)).execute()) as (typeof s.leads.$inferSelect)[];
  const flagged = flaggedRows.find((r) => r.businessId === dogfoodId);
  if (!flagged) console.log("DIAG flaggedRows:", JSON.stringify(flaggedRows.map((r) => ({ biz: r.businessId, optedOut: r.optedOut, ch: r.optOutChannel, notes: r.notes }))));
  const f = flagged as (typeof s.leads.$inferSelect) | undefined;
  pass(
    "deletion: opted-out (channel all) + marker, row NOT deleted",
    f !== undefined && f.optedOut === 1 && f.optOutChannel === "all" && String(f.notes).includes("[hubspot deleted")
  );
  // Re-flag is a diff-guard noop.
  const d2 = await processHubSpotWebhookEvents(client, [
    { eventId: 4003, subscriptionType: "contact.deletion", objectId: 913, propertyName: "email", propertyValue: email, occurredAt: Date.now(), attemptNumber: 0 },
  ]);
  pass("deletion: already-flagged re-delivery is a noop (processed, not re-flagged)", d2.processed === 1 && d2.flagged === 0);
  // Unknown email → skipped, never an error.
  const d3 = await processHubSpotWebhookEvents(client, [
    { eventId: 4004, subscriptionType: "contact.deletion", objectId: 913, propertyName: "email", propertyValue: "nobody@example.com", occurredAt: Date.now(), attemptNumber: 0 },
  ]);
  assertEq("deletion: unknown email skipped", [d3.skipped, d3.errors], [1, 0]);
}

// ---- 7. company events acknowledged -------------------------------------------
{
  const { client } = fakeClient({});
  const r = await processHubSpotWebhookEvents(client, [
    { eventId: 5001, subscriptionType: "company.creation", objectId: 771, occurredAt: Date.now(), attemptNumber: 0 },
    { eventId: 5002, subscriptionType: "company.propertyChange", objectId: 771, propertyName: "name", propertyValue: "Acme", occurredAt: Date.now(), attemptNumber: 0 },
  ]);
  assertEq("company events: skipped (contacts-only), no errors", [r.skipped, r.errors], [2, 0]);
}

// ---- 8. last_sync_at refreshed, cursor untouched -------------------------------
{
  await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts", { lastSyncAt: 1000, lastCursor: "1700000000000", status: "ok" });
  const { client } = fakeClient({ "914": hsContact(`wh-cursor-${suffix}@example.com`, "914") });
  await processHubSpotWebhookEvents(client, [
    { eventId: 6001, subscriptionType: "contact.creation", objectId: 914, occurredAt: Date.now(), attemptNumber: 0 },
  ]);
  const row = await getSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts");
  pass("webhook completion: last_sync_at refreshed", (row?.lastSyncAt ?? 0) > 1000);
  pass("webhook completion: polling cursor NOT touched", row?.lastCursor === "1700000000000");
}

// ---- 9. HTTP signature enforcement ----------------------------------------------
{
  process.env.HUBSPOT_WEBHOOK_SECRET = "testsecret";
  const app = await createApp();
  const body = JSON.stringify([{ eventId: 7001, subscriptionType: "contact.creation", objectId: 1 }]);
  const bad = await app.request("/api/webhooks/hubspot", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hubspot-signature": "deadbeef" },
    body,
  });
  pass("route: bad signature → 401", bad.status === 401);
  const missing = await app.request("/api/webhooks/hubspot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  pass("route: missing signature with secret set → 401", missing.status === 401);
  delete process.env.HUBSPOT_WEBHOOK_SECRET;
}

// ---- 10. route-level idempotency guard (shared upsert is idempotent) --------------
{
  // upsertInboundPlan twice with the same plan: created then noop-ish.
  const contact = hsContact(`wh-shared-${suffix}@example.com`, "915");
  const before = (await db.select().from(s.leads).execute()).length;
  const o1 = await upsertInboundPlan(mapHubSpotContactToInbound(contact), BIZ_ID);
  const o2 = await upsertInboundPlan(mapHubSpotContactToInbound(contact), BIZ_ID);
  const after = (await db.select().from(s.leads).execute()).length;
  assertEq("shared upsert: created then noop, one row total", [o1, o2, after - before], ["created", "noop", 1]);
}

// ---- cleanup --------------------------------------------------------------------
for (const l of await db.select().from(s.leads).where(eq(s.leads.businessId, BIZ_ID)).execute()) await db.delete(s.leads).where(eq(s.leads.id, l.id)).execute();
await recordWebhookEventIds([]); // no-op guard
await db.delete(s.syncState).where(eq(s.syncState.provider, HUBSPOT_SYNC_PROVIDER)).execute();
for (const i of await db.select().from(s.integrations).where(eq(s.integrations.businessId, BIZ_ID)).execute()) await db.delete(s.integrations).where(eq(s.integrations.id, i.id)).execute();
for (const sub of await db.select().from(s.subscriptions).where(eq(s.subscriptions.businessId, BIZ_ID)).execute()) await db.delete(s.subscriptions).where(eq(s.subscriptions.id, sub.id)).execute();
await db.delete(s.teamMembers).where(eq(s.teamMembers.businessId, BIZ_ID)).execute();
await db.delete(s.businesses).where(eq(s.businesses.id, BIZ_ID)).execute();
await db.delete(s.users).where(eq(s.users.id, owner!.id)).execute();
console.log(failures === 0 ? "\nALL TESTS PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
