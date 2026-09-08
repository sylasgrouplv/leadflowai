/**
 * CRM two-way sync — the polling job (HubSpot ↔ ctomail, Phase 1 task 2).
 *
 * Engine-connector model (closest patterns: social/engine.ts + the BI
 * weekly job): a scheduled worker pulls HubSpot-side changes INTO the local
 * leads table (inbound) and pushes local lead changes OUT to HubSpot
 * (outbound), with the per-direction watermark persisted in `sync_state`
 * (migration 0016 / pg 0009).
 *
 *   runHubSpotSync()   both directions, contacts entity
 *     ├─ pullHubSpotContacts()  inbound: list HubSpot contacts with
 *     │   hs_lastmodifieddate > cursor (search endpoint, ≤100/page, paced),
 *     │   upsert each into `leads` keyed by email (create when absent,
 *     │   PATCH mapping fields when present), then advance the cursor.
 *     └─ pushLeadsToHubSpot()   outbound: local leads with updated_at >
 *         cursor (both dialects store epoch ms), batch-upsert by email
 *         (≤100/chunk, paced), then advance the cursor.
 *
 * Every run:
 *   - is IDEMPOTENT — strictly-after cursor + email-keyed upserts; a re-run
 *     re-reads the same window and writes the same values,
 *   - respects HubSpot rate limits — search pages and ≤100-record batch
 *     chunks are paced with the import's sleep budget (~≤100 req/10s),
 *   - fails safe — the cursor advances only after the direction's work
 *     completes; a failed run records status='error' + the message, leaves
 *     the cursor untouched, and the next run naturally retries the window,
 *   - runs on ONE tick per interval — a direction runs only when its
 *     (portal-level, not tenant-level) state row exists, which only the
 *     sync-state bootstrap creates.
 *
 * Graceful skip: with CRM_PROVIDER != 'hubspot' OR no HUBSPOT_API_KEY the
 * job returns { skipped: "not_configured" } without touching anything —
 * the platform stays fully functional with the default mock CRM.
 *
 * Tenant scope: the sync operates at PORTAL level (the dogfood HubSpot
 * portal holds records for the whole company — see hubspot-import.ts), so
 * inbound rows are matched to the dogfood tenant ("LeadFlow AI") by email;
 * unmatched rows are counted and skipped, never misfiled into another
 * business.
 */
import { and, asc, eq, gt, ne } from "drizzle-orm";
import { env } from "../env";
import { getDb } from "../db/client";
import * as s from "../db/schema";
import { HubSpotClient, LF_CONTACT_READ_PROPERTIES, toHubSpotLeadStatus } from "../integrations/hubspot";
import type { HubSpotObject } from "../integrations/hubspot";

/** The connector name recorded in sync_state.provider (CRM_PROVIDER value). */
export const HUBSPOT_SYNC_PROVIDER = "hubspot";
/** Entities carried per direction (Phase 1 scope: contacts on both ways). */
export const SYNC_DIRECTION_ENTITIES: Record<(typeof s.SYNC_DIRECTIONS)[number], s.SyncEntity[]> = {
  inbound: ["contacts"],
  outbound: ["contacts"],
};
/** Pacing between HubSpot calls — ~≤100 req/10s on a free portal (import §2). */
const HUBSPOT_CALL_DELAY_MS = 120;
/** Search page size (HubSpot max 100). */
const PAGE_SIZE = 100;
/** Batch upsert chunk size (HubSpot max 100 inputs). */
const BATCH_SIZE = 100;
/** Backstop window: on the FIRST run (no cursor) start here, not at epoch. */
const INITIAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Outbound cap per run — the scheduler tick stays short even on a big delta. */
const MAX_OUTBOUND_PER_RUN = 500;
/** Inbound page cap per run — same tick-budget guard. */
const MAX_INBOUND_PAGES_PER_RUN = 20;
/** The local tenant inbound contacts are filed under (portal-level sync). */
const DOGFOOD_BUSINESS_NAME = "LeadFlow AI";

const norm = (v: unknown): string => (v ?? "").toString().trim();

// ---------------------------------------------------------------------------
// sync_state access (the cursor store)
// ---------------------------------------------------------------------------

export interface SyncStateRow {
  id: string;
  provider: string;
  direction: string;
  entity: string;
  lastSyncAt: number | null;
  lastCursor: string | null;
  status: string;
  error: string | null;
  metaJson: string;
  createdAt: number;
  updatedAt: number;
}

function parseMeta(row: Pick<SyncStateRow, "metaJson">): {
  pushed: number;
  pulled: number;
  skipped: number;
  errors: number;
  runs: number;
} {
  try {
    const m = JSON.parse(row.metaJson || "{}") as Record<string, unknown>;
    return {
      pushed: Number(m.pushed ?? 0),
      pulled: Number(m.pulled ?? 0),
      skipped: Number(m.skipped ?? 0),
      errors: Number(m.errors ?? 0),
      runs: Number(m.runs ?? 0),
    };
  } catch {
    return { pushed: 0, pulled: 0, skipped: 0, errors: 0, runs: 0 };
  }
}

/** Read one cursor row (null when the direction has never been bootstrapped). */
export async function getSyncState(provider: string, direction: string, entity: string): Promise<SyncStateRow | null> {
  const rows = await getDb()
    .select()
    .from(s.syncState)
    .where(and(eq(s.syncState.provider, provider), eq(s.syncState.direction, direction), eq(s.syncState.entity, entity)))
    .limit(1)
    .execute();
  return (rows[0] as SyncStateRow | undefined) ?? null;
}

/** Insert-or-update the cursor row (idempotent on the unique triple). */
export async function upsertSyncState(
  provider: string,
  direction: string,
  entity: string,
  patch: Partial<Pick<SyncStateRow, "lastSyncAt" | "lastCursor" | "status" | "error">> & { meta?: Record<string, number> }
): Promise<SyncStateRow> {
  const db = getDb();
  const t = Date.now();
  const existing = await getSyncState(provider, direction, entity);
  if (!existing) {
    const id = crypto.randomUUID();
    await db
      .insert(s.syncState)
      .values({
        id,
        provider,
        direction,
        entity,
        lastSyncAt: patch.lastSyncAt ?? null,
        lastCursor: patch.lastCursor ?? null,
        status: patch.status ?? "idle",
        error: patch.error ?? null,
        metaJson: JSON.stringify(patch.meta ?? {}),
        createdAt: t,
        updatedAt: t,
      })
      .execute();
    return (await getSyncState(provider, direction, entity))!;
  }
  const mergedMeta = patch.meta ? { ...parseMeta(existing), ...patch.meta } : undefined;
  await db
    .update(s.syncState)
    .set({
      ...(patch.lastSyncAt !== undefined ? { lastSyncAt: patch.lastSyncAt } : {}),
      ...(patch.lastCursor !== undefined ? { lastCursor: patch.lastCursor } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(mergedMeta ? { metaJson: JSON.stringify(mergedMeta) } : {}),
      updatedAt: t,
    })
    .where(eq(s.syncState.id, existing.id))
    .execute();
  return (await getSyncState(provider, direction, entity))!;
}

// ---------------------------------------------------------------------------
// Config gate + entity scope
// ---------------------------------------------------------------------------

export interface SyncConfig {
  ok: boolean;
  reason: string;
  client: HubSpotClient | null;
}

/** TRUE config gate: CRM_PROVIDER=hubspot AND a non-empty key are BOTH required. */
export function resolveSyncConfig(keyOverride?: string, providerOverride?: string): SyncConfig {
  const provider = providerOverride ?? env.crmProvider;
  const key = keyOverride ?? env.hubspotApiKey;
  if (provider !== "hubspot") {
    return { ok: false, reason: `CRM_PROVIDER is '${provider}', not 'hubspot'`, client: null };
  }
  if (!key) {
    return { ok: false, reason: "HUBSPOT_API_KEY is not set", client: null };
  }
  return { ok: true, reason: "", client: new HubSpotClient({ apiKey: key }) };
}

/** Entities a direction carries (exported for tests/tools). */
export function entitiesForDirection(direction: string): s.SyncEntity[] {
  const d = direction as (typeof s.SYNC_DIRECTIONS)[number];
  return SYNC_DIRECTION_ENTITIES[d] ?? [];
}

// ---------------------------------------------------------------------------
// Field mapping — HubSpot contact -> local lead row (inbound)
// ---------------------------------------------------------------------------

const STATUS_TO_LEAD: Record<string, s.LeadStatus> = {
  NEW: "new",
  ATTEMPTED_TO_CONTACT: "contacted",
  IN_PROGRESS: "qualified",
  OPEN_DEAL: "appointment_booked",
  CONNECTED: "customer",
  BAD_TIMING: "lost",
  UNQUALIFIED: "unqualified",
  OPEN: "needs_human",
};

function hubSpotTimestamp(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface InboundPlan {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  serviceRequested: string;
  location: string;
  status: s.LeadStatus | null;
  classification: string | null;
  scoreValue: number | null;
  /** False when the contact has no email (nothing to dedupe on — skipped). */
  ok: boolean;
  skipReason: string;
}

/** Pure mapper so tests cover the transformation without any client. */
export function mapHubSpotContactToInbound(contact: HubSpotObject): InboundPlan {
  const p = contact.properties ?? {};
  const email = norm(p.email).toLowerCase();
  if (!email) return { email: "", firstName: "", lastName: "", phone: "", serviceRequested: "", location: "", status: null, classification: null, scoreValue: null, ok: false, skipReason: "no email (dedupe key)" };
  const score = Number(p.lf_lead_score);
  const statusRaw = norm(p.hs_lead_status).toUpperCase();
  const classification = norm(p.lf_classification) || null;
  const status = STATUS_TO_LEAD[statusRaw] ?? (classification === "UNQUALIFIED" ? "unqualified" : null);
  return {
    email,
    firstName: norm(p.firstname),
    lastName: norm(p.lastname),
    phone: norm(p.phone),
    serviceRequested: norm(p.lf_service_requested),
    location: norm(p.lf_location),
    status,
    classification,
    scoreValue: Number.isFinite(score) && score > 0 ? score : null,
    ok: true,
    skipReason: "",
  };
}

// ---------------------------------------------------------------------------
// Inbound pull — HubSpot contacts -> local leads (email-keyed upsert)
// ---------------------------------------------------------------------------

export interface InboundResult {
  cursorFrom: string | null;
  /** Post-run watermark: advanced on a clean run, unchanged on any error. */
  cursorTo: string | null;
  pulled: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  /** First error message seen this run (cursor-held diagnostics). */
  lastErrorMessage: string;
}

/**
 * Single-record inbound upsert — the SHARED write path for "HubSpot contact
 * → local lead" used by BOTH the polling pull (`pullHubSpotContacts`, one row
 * per query) and the webhook receiver (`crm/webhooks.ts`, one row per event).
 * Any change to the inbound mapping semantics goes here, never in the
 * callers — that is the single-source-of-truth guarantee.
 *
 * Email-keyed, diff-guarded: creates the row under the dogfood tenant when
 * absent, PATCHes only fields that actually differ (writing identical state
 * back would bump updated_at and ping-pong with the outbound push). Returns
 * "created" | "updated" | "noop" (noop = row already identical).
 */
export async function upsertInboundPlan(
  plan: InboundPlan,
  bizId: string
): Promise<"created" | "updated" | "noop"> {
  const db = getDb();
  const existingRows = await db
    .select()
    .from(s.leads)
    .where(and(eq(s.leads.businessId, bizId), eq(s.leads.email, plan.email)))
    .limit(1)
    .execute();
  const existing = existingRows[0] as typeof s.leads.$inferSelect | undefined;
  if (!existing) {
    await db.insert(s.leads).values({
      id: crypto.randomUUID(),
      businessId: bizId,
      firstName: plan.firstName,
      lastName: plan.lastName,
      phone: plan.phone,
      email: plan.email,
      source: "hubspot_sync",
      serviceRequested: plan.serviceRequested,
      location: plan.location,
      ...(plan.status ? { status: plan.status } : {}),
      ...(plan.classification ? { classification: plan.classification } : {}),
      ...(plan.scoreValue !== null ? { scoreValue: plan.scoreValue, score: plan.scoreValue >= 70 ? "hot" : plan.scoreValue >= 40 ? "warm" : "cold" } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).execute();
    return "created";
  }
  // Diff-guard: patch ONLY fields that actually differ. Writing the
  // same value back would bump updated_at, which the outbound push
  // would then re-send to HubSpot, which would bump
  // hs_lastmodifieddate for the next inbound pull — a low-grade
  // infinite loop. Identical state must be a no-op on both sides.
  const patch: Record<string, unknown> = {};
  const textFields: [string, string][] = [
    ["firstName", plan.firstName],
    ["lastName", plan.lastName],
    ["phone", plan.phone],
    ["serviceRequested", plan.serviceRequested],
    ["location", plan.location],
  ];
  for (const [col, incoming] of textFields) {
    const cur = norm((existing as Record<string, unknown>)[col]);
    if (incoming && incoming !== cur) patch[col] = incoming;
  }
  if (plan.status && plan.status !== existing.status) patch.status = plan.status;
  if (plan.classification && plan.classification !== existing.classification) patch.classification = plan.classification;
  if (plan.scoreValue !== null && plan.scoreValue !== existing.scoreValue) patch.scoreValue = plan.scoreValue;
  if (Object.keys(patch).length === 0) return "noop";
  patch.updatedAt = Date.now();
  await db.update(s.leads).set(patch).where(and(eq(s.leads.id, existing.id), eq(s.leads.businessId, bizId))).execute();
  return "updated";
}

/** Resolve the dogfood tenant id inbound rows are filed under (portal-level sync). */
export async function getDogfoodBusinessId(): Promise<string> {
  const bizRows = await getDb()
    .select()
    .from(s.businesses)
    .where(eq(s.businesses.name, DOGFOOD_BUSINESS_NAME))
    .limit(1)
    .execute();
  const biz = bizRows[0];
  if (!biz) {
    throw new Error(`dogfood tenant '${DOGFOOD_BUSINESS_NAME}' not found — cannot file inbound contacts`);
  }
  return biz.id;
}

/**
 * Full single-record inbound pipeline: map a HubSpot contact → upsert into
 * the dogfood tenant. The webhook receiver calls this per event (returned
 * "skipped" when the contact has no email dedupe key). The polling pull
 * batches the same work inline for query efficiency (one email-index query
 * per page) but writes through the identical `upsertInboundPlan`.
 */
export async function upsertInboundContact(contact: HubSpotObject): Promise<"created" | "updated" | "noop" | "skipped"> {
  const plan = mapHubSpotContactToInbound(contact);
  if (!plan.ok) return "skipped";
  const bizId = await getDogfoodBusinessId();
  return upsertInboundPlan(plan, bizId);
}

/**
 * HubSpot-side deletion → local flag/archive. NEVER hard-deletes: marks the
 * email-matched lead opted-out (channel "all", stops all follow-up per the
 * spec §9 stop rule) and appends a deletion marker to `notes`. A no-email
 * contact or an unmatched email is a no-op ("skipped").
 */
export async function flagInboundDeletion(email: string): Promise<"flagged" | "noop" | "skipped"> {
  const key = norm(email).toLowerCase();
  if (!key) return "skipped";
  const db = getDb();
  const bizId = await getDogfoodBusinessId();
  const rows = await db
    .select()
    .from(s.leads)
    .where(and(eq(s.leads.businessId, bizId), eq(s.leads.email, key)))
    .limit(1)
    .execute();
  const existing = rows[0] as typeof s.leads.$inferSelect | undefined;
  if (!existing) return "skipped";
  const alreadyFlagged = existing.optedOut === 1 && norm(existing.notes).includes("[hubspot deleted");
  if (alreadyFlagged) return "noop";
  const marker = `[hubspot deleted ${new Date().toISOString().slice(0, 10)}]`;
  await db
    .update(s.leads)
    .set({
      optedOut: 1,
      optOutChannel: "all",
      notes: norm(existing.notes) ? `${norm(existing.notes)} ${marker}` : marker,
      updatedAt: Date.now(),
    })
    .where(and(eq(s.leads.id, existing.id), eq(s.leads.businessId, bizId)))
    .execute();
  return "flagged";
}

export async function pullHubSpotContacts(client: HubSpotClient, cursorFrom: string | null): Promise<InboundResult> {
  // On the first run start at a 7-day backstop rather than the portal's full
  // history (the one-time backfill import already covered history — PR #26).
  const fromMs = cursorFrom ? Number(cursorFrom) : Date.now() - INITIAL_WINDOW_MS;
  const result: InboundResult = { cursorFrom, cursorTo: cursorFrom, pulled: 0, created: 0, updated: 0, skipped: 0, errors: 0, lastErrorMessage: "" };

  // The portal-level tenant inbound rows are filed under (the "LeadFlow AI"
  // dogfood tenant; rows whose email matches no lead in it are created there,
  // never misfiled into another business).
  const bizId = await getDogfoodBusinessId();

  // Page HubSpot contacts strictly after the watermark (hs_lastmodifieddate).
  let after: string | undefined;
  let newestSeen = fromMs;
  for (let page = 0; page < MAX_INBOUND_PAGES_PER_RUN; page += 1) {
    // Search contacts strictly after the watermark (hs_lastmodifieddate, epoch ms).
    const searchRes = await client.searchContacts({
      filterGroups: [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GT", value: String(fromMs) }] }],
      sorts: ["hs_lastmodifieddate"],
      properties: [...LF_CONTACT_READ_PROPERTIES],
      limit: PAGE_SIZE,
      ...(after ? { after: Number(after) } : {}),
    });
    const contacts = searchRes.results;
    if (contacts.length === 0) break;
    // Every row writes through the SHARED upsertInboundPlan — the same write
    // path the webhook receiver uses (single source of truth).
    for (const contact of contacts) {
      const plan = mapHubSpotContactToInbound(contact);
      if (!plan.ok) {
        result.skipped += 1;
        continue;
      }
      const modified = hubSpotTimestamp(contact.properties?.hs_lastmodifieddate);
      if (modified && modified > newestSeen) newestSeen = modified;
      result.pulled += 1;
      try {
        // Single write path (same as the webhook receiver); the outcome
        // drives the counters. No page-local read cache: a duplicate email
        // inside one page hits the diff-guard on the second copy and is a
        // no-op rather than a double-create attempt.
        const outcome = await upsertInboundPlan(plan, bizId);
        if (outcome === "created") result.created += 1;
        else if (outcome === "updated") result.updated += 1;
      } catch (e) {
        result.errors += 1;
        if (!result.lastErrorMessage) result.lastErrorMessage = e instanceof Error ? e.message : String(e);
        console.error(`[hubspot-sync] inbound upsert failed for ${plan.email}:`, e);
      }
      await new Promise((r) => setTimeout(r, HUBSPOT_CALL_DELAY_MS));
    }
    const next = searchRes.paging?.next?.after;
    if (!next) break;
    after = String(next);
  }

  // Advance the cursor ONLY when every pulled row landed cleanly: to the
  // newest hs_lastmodifieddate actually processed (NOT Date.now(), so a
  // concurrent write between page fetches is not silently dropped). On any
  // error the cursor stays EXACTLY where it was (null stays null) — the next
  // run retries the same window, and the email-keyed upserts make that safe.
  result.cursorTo = result.errors === 0 ? String(newestSeen > fromMs ? newestSeen : fromMs) : cursorFrom;
  return result;
}

// ---------------------------------------------------------------------------
// Outbound push — local leads -> HubSpot contacts (batch upsert by email)
// ---------------------------------------------------------------------------

export interface OutboundResult {
  cursorFrom: string | null;
  /** Post-run watermark: advanced on a fully-clean run, unchanged on any error. */
  cursorTo: string | null;
  pushed: number;
  errors: number;
  skipped: number;
  /** First error message seen this run (cursor-held diagnostics). */
  lastErrorMessage: string;
}

/** Lead row -> HubSpot contact properties (§3.1 mapping; the provider's
 *  toHubSpotContactProperties expects the CrmLead shape). Exported for the
 *  hermetic test (hubspot-sync-test.ts). */
export function leadToProperties(l: typeof s.leads.$inferSelect): Record<string, string> {
  const props: Record<string, string> = {
    email: norm(l.email).toLowerCase(),
    firstname: norm(l.firstName),
    lastname: norm(l.lastName),
    phone: norm(l.phone),
    lf_service_requested: norm(l.serviceRequested),
    lf_location: norm(l.location),
    lf_opted_out: l.optedOut ? "1" : "0",
  };
  if (l.scoreValue > 0) props.lf_lead_score = String(l.scoreValue);
  if (l.classification && l.classification !== "COLD") props.lf_classification = l.classification;
  if (l.status) props.hs_lead_status = toHubSpotLeadStatus(l.status);
  return props;
}

export async function pushLeadsToHubSpot(client: HubSpotClient, cursorFrom: string | null): Promise<OutboundResult> {
  const db = getDb();
  const fromMs = cursorFrom ? Number(cursorFrom) : Date.now() - INITIAL_WINDOW_MS;
  const cursorTo = String(Date.now());
  const result: OutboundResult = { cursorFrom, cursorTo: cursorFrom, pushed: 0, errors: 0, skipped: 0, lastErrorMessage: "" };

  // Local delta: leads touched since the watermark (both dialects store epoch
  // ms in updated_at). The dogfood tenant owns the outbound surface, same as
  // inbound — portal-level sync, single local tenant.
  const bizRows = await db.select().from(s.businesses).where(eq(s.businesses.name, DOGFOOD_BUSINESS_NAME)).limit(1).execute();
  const biz = bizRows[0];
  if (!biz) throw new Error(`dogfood tenant '${DOGFOOD_BUSINESS_NAME}' not found — cannot file outbound pushes`);

  // hubspot_sync-sourced rows are EXCLUDED: they are mirrors of HubSpot
  // state — pushing them back would bounce every inbound pull straight out
  // again (a same-run echo loop the diff-guard cannot prevent, since the
  // mirror write itself is the update).
  const changed = await db
    .select()
    .from(s.leads)
    .where(and(eq(s.leads.businessId, biz.id), gt(s.leads.updatedAt, fromMs), ne(s.leads.source, "hubspot_sync")))
    .orderBy(asc(s.leads.updatedAt))
    .limit(MAX_OUTBOUND_PER_RUN)
    .execute();

  // Only leads with an email can be keyed to HubSpot; skip prospect rows
  // without one (their HubSpot mirror is the lf_import_key contact — the
  // backfill import's job, not the polling loop's).
  const withEmail = changed.filter((l) => norm(l.email));
  result.skipped = changed.length - withEmail.length;

  // Batch-upsert in ≤100-record chunks, paced (rate-limit budget). The push
  // never writes back to the local rows, so it cannot bump updated_at and
  // re-qualify itself — the watermark below is the only loop guard needed.
  for (let i = 0; i < withEmail.length; i += BATCH_SIZE) {
    const chunk = withEmail.slice(i, i + BATCH_SIZE);
    const inputs = chunk.map((l) => ({ email: norm(l.email).toLowerCase(), properties: leadToProperties(l) }));
    try {
      const upserted = await client.batchUpsertContacts(inputs);
      result.pushed += upserted.length;
    } catch (e) {
      // Chunk failed as a whole — record the errors and continue with the
      // next chunk; the cursor is NOT advanced past failed rows (below).
      result.errors += chunk.length;
      if (!result.lastErrorMessage) result.lastErrorMessage = e instanceof Error ? e.message : String(e);
      console.error(`[hubspot-sync] outbound batch failed (chunk ${i / BATCH_SIZE + 1}):`, e);
    }
    await new Promise((r) => setTimeout(r, HUBSPOT_CALL_DELAY_MS));
  }

  // Advance the outbound cursor to the run's read boundary (Date.now() at
  // completion, ≥ every fetched row's updatedAt) ONLY when every chunk
  // landed; the next window is strictly-greater than this boundary, so pushed
  // rows are excluded while any change made during/after the push
  // (updatedAt > boundary) is picked up next run — no lost updates, no echo
  // loop. On ANY chunk error the cursor stays EXACTLY where it was (null
  // stays null): the failed rows (and any newer rows behind them) re-qualify
  // next run, and the email-keyed upserts make the retry safe.
  result.cursorTo = result.errors === 0 ? String(Math.max(fromMs, Date.now())) : cursorFrom;
  return result;
}

// ---------------------------------------------------------------------------
// The job — both directions, run-to-completion, cursor per direction
// ---------------------------------------------------------------------------

export interface HubSpotSyncRun {
  ok: boolean;
  skipped: string;
  inbound: InboundResult | null;
  outbound: OutboundResult | null;
  errors: number;
  durationMs: number;
}

/**
 * Run one full sync pass. Registered in jobs/scheduler.ts; safe to call
 * repeatedly (idempotent upserts + strictly-advancing cursors). With the
 * provider unconfigured this returns skipped='not_configured' and never
 * touches the DB or the network.
 *
 * `clientOverride` (tests): injects a HubSpotClient double so a run can be
 * exercised hermetically — production callers never pass it.
 */
export async function runHubSpotSync(
  opts: { apiKey?: string; provider?: string; clientOverride?: HubSpotClient } = {}
): Promise<HubSpotSyncRun> {
  const started = Date.now();
  const cfg = resolveSyncConfig(opts.apiKey, opts.provider);
  if (!cfg.ok) {
    return { ok: true, skipped: "not_configured", inbound: null, outbound: null, errors: 0, durationMs: Date.now() - started };
  }
  const client = opts.clientOverride ?? cfg.client!;
  const run: HubSpotSyncRun = { ok: true, skipped: "", inbound: null, outbound: null, errors: 0, durationMs: 0 };

  // ---- inbound ----
  const inState = await getSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts");
  try {
    const res = await pullHubSpotContacts(client, inState?.lastCursor ?? null);
    run.inbound = res;
    run.errors += res.errors;
    await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts", {
      lastSyncAt: Date.now(),
      lastCursor: res.cursorTo,
      status: res.errors > 0 ? "error" : "ok",
      error: res.errors > 0 ? `${res.errors} upsert error(s) during inbound pull: ${res.lastErrorMessage}`.slice(0, 500) : null,
      meta: { pulled: res.pulled, skipped: res.skipped, errors: res.errors },
    });
  } catch (e) {
    run.ok = false;
    run.errors += 1;
    const msg = e instanceof Error ? e.message : String(e);
    await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts", {
      lastSyncAt: inState?.lastSyncAt ?? null,
      status: "error",
      error: msg.slice(0, 500),
    }).catch(() => {});
  }

  // ---- outbound ----
  const outState = await getSyncState(HUBSPOT_SYNC_PROVIDER, "outbound", "contacts");
  try {
    const res = await pushLeadsToHubSpot(client, outState?.lastCursor ?? null);
    run.outbound = res;
    run.errors += res.errors;
    await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "outbound", "contacts", {
      lastSyncAt: Date.now(),
      lastCursor: res.cursorTo,
      status: res.errors > 0 ? "error" : "ok",
      error: res.errors > 0 ? `${res.errors} push error(s) during outbound push: ${res.lastErrorMessage}`.slice(0, 500) : null,
      meta: { pushed: res.pushed, skipped: res.skipped, errors: res.errors },
    });
  } catch (e) {
    run.ok = false;
    run.errors += 1;
    const msg = e instanceof Error ? e.message : String(e);
    await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "outbound", "contacts", {
      lastSyncAt: outState?.lastSyncAt ?? null,
      status: "error",
      error: msg.slice(0, 500),
    }).catch(() => {});
  }

  run.durationMs = Date.now() - started;
  return run;
}
