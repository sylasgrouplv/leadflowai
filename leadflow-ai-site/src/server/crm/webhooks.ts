/**
 * HubSpot webhook receiver (HubSpot ↔ ctomail two-way sync, Phase 1 task 3).
 *
 * HubSpot subscriptions POST batches of events to
 * `POST /api/webhooks/hubspot`:
 *
 *   [{ eventId, subscriptionType, portalId, objectId, propertyName,
 *      propertyValue, occurredAt, attemptNumber }, …]
 *
 * (v1 webhooks also send `X-HubSpot-Signature` = SHA-256 hex of
 *  `clientSecret + rawRequestBody`; v3 sends `X-HubSpot-Signature-v3` with a
 *  timestamped variant. We verify the v1 scheme — the one the app-secret
 *  setup documents — and accept the v3 header presence as informational.)
 *
 * Per event the receiver fetches the record by objectId and runs it through
 * the SAME inbound pipeline as the polling job (`crm/sync.ts`):
 * `mapHubSpotContactToInbound` → `upsertInboundPlan` (email-keyed,
 * diff-guarded). The polling cursor is NEVER touched here (it still belongs
 * to the poller); only the inbound row's `last_sync_at` is refreshed on
 * completion.
 *
 * Idempotency: processed eventIds are recorded in the inbound sync_state
 * meta JSON (`webhookEventIds`, capped ring of the most recent N) so
 * `attemptNumber` replays and duplicate deliveries are no-ops before any
 * HubSpot fetch. Even without that record the upserts themselves are fully
 * idempotent (diff-guard), so a replay at worst re-reads and no-ops.
 */
import { Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../env";
import {
  HUBSPOT_SYNC_PROVIDER,
  getSyncState,
  resolveSyncConfig,
  upsertInboundContact,
  flagInboundDeletion,
  upsertSyncState,
} from "./sync";
import type { HubSpotClient, HubSpotObject } from "../integrations/hubspot";
import { isHubSpotStatus } from "../integrations/hubspot";

/** Env var holding the HubSpot app client secret used to verify webhooks. */
export const HUBSPOT_WEBHOOK_SECRET_ENV = "HUBSPOT_WEBHOOK_SECRET";
/** Max processed-eventIds remembered in sync_state meta (FIFO ring). */
export const WEBHOOK_EVENT_ID_RING_SIZE = 500;

/** Raw HubSpot webhook event (fields per the subscriptions API docs). */
export interface HubSpotWebhookEvent {
  eventId?: number | string;
  subscriptionType?: string;
  eventType?: string;
  portalId?: number;
  objectId?: number | string;
  propertyName?: string;
  propertyValue?: string;
  occurredAt?: number | string;
  attemptNumber?: number;
}

export interface WebhookProcessResult {
  received: number;
  processed: number;
  created: number;
  updated: number;
  flagged: number;
  skipped: number;
  duplicates: number;
  errors: number;
  lastErrorMessage: string;
}

const norm = (v: unknown): string => (v ?? "").toString().trim().toLowerCase();

/** Resolve the webhook verification secret (empty = not configured). */
export function resolveWebhookSecret(secretOverride?: string): string {
  if (secretOverride !== undefined) return secretOverride;
  return env.hubspotWebhookSecret;
}

/**
 * Verify a HubSpot v1 webhook signature: SHA-256 hex of
 * `secret + rawRequestBody` compared against `X-HubSpot-Signature`.
 * Returns true when no secret is configured (dev/dogfood default — log +
 * accept; production MUST set the secret).
 */
export function verifyHubSpotSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!secret) return true;
  if (!signature) return false;
  const expected = createHash("sha256").update(secret + rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Contact-side subscription types the receiver handles. */
function classifyContactEvent(subscriptionType: string): "upsert" | "deletion" | "ignore" {
  const t = subscriptionType.toLowerCase();
  if (t === "contact.deletion") return "deletion";
  if (t === "contact.creation" || t === "contact.propertychange") return "upsert";
  return "ignore";
}

/** Company-side subscription types (logged + counted, not synced — Phase 1 scope is contacts). */
function isCompanyEvent(subscriptionType: string): boolean {
  return subscriptionType.toLowerCase().startsWith("company.");
}

/** Read the processed-eventId ring from the inbound sync_state meta. */
async function readWebhookEventIds(): Promise<string[]> {
  const row = await getSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts");
  if (!row) return [];
  try {
    const m = JSON.parse(row.metaJson || "{}") as Record<string, unknown>;
    const ids = m.webhookEventIds;
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Record eventIds into the inbound sync_state meta ring (FIFO, capped).
 * Updates ONLY the meta blob — lastSyncAt/lastCursor/status are untouched
 * (the caller refreshes last_sync_at separately on completion).
 */
export async function recordWebhookEventIds(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  const seen = await readWebhookEventIds();
  const set = new Set(seen);
  const merged = [...seen];
  for (const id of eventIds) {
    if (set.has(id)) continue;
    set.add(id);
    merged.push(id);
  }
  const trimmed = merged.slice(-WEBHOOK_EVENT_ID_RING_SIZE);
  const existing = await getSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts");
  if (!existing) {
    // Poller never bootstrapped (webhook-only mode): create the row so the
    // ring has a home. Cursor stays null — the poller's first run still
    // starts from its backstop window; status stays "idle".
    await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts", {
      status: "idle",
      meta: { webhookEventIds: trimmed } as unknown as Record<string, number>,
    });
    return;
  }
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(existing.metaJson || "{}") as Record<string, unknown>;
  } catch {
    meta = {};
  }
  meta.webhookEventIds = trimmed;
  await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts", {
    meta: meta as unknown as Record<string, number>,
  });
}

/**
 * Process one batch of webhook events. `client` is the configured
 * HubSpotClient (tests inject a double; production passes the real one).
 * Fetches each object by id and runs it through the shared inbound upsert;
 * contact.deletion flags the local lead instead (never hard-deletes).
 */
export async function processHubSpotWebhookEvents(
  client: HubSpotClient,
  events: HubSpotWebhookEvent[]
): Promise<WebhookProcessResult> {
  const res: WebhookProcessResult = {
    received: events.length,
    processed: 0,
    created: 0,
    updated: 0,
    flagged: 0,
    skipped: 0,
    duplicates: 0,
    errors: 0,
    lastErrorMessage: "",
  };
  const seenIds = new Set(await readWebhookEventIds());
  const newlySeen: string[] = [];

  for (const ev of events) {
    const eventId = ev.eventId !== undefined && ev.eventId !== null ? String(ev.eventId) : "";
    const subType = norm(ev.subscriptionType ?? ev.eventType);
    const objectId = norm(ev.objectId);
    if (!subType || !objectId) {
      res.skipped += 1;
      continue;
    }
    // Idempotency: replays (attemptNumber) and duplicate deliveries no-op.
    if (eventId && seenIds.has(eventId)) {
      res.duplicates += 1;
      continue;
    }
    if (isCompanyEvent(subType)) {
      // Phase 1 scope is contacts — company events are acknowledged and
      // counted, not synced (a company sync is Phase 2 work).
      res.skipped += 1;
      console.log(`[hubspot-webhook] company event ${subType} object ${objectId} acknowledged (contacts-only sync)`);
    } else if (classifyContactEvent(subType) === "deletion") {
      try {
        // Deleted contacts are usually unreadable — flag by the
        // propertyValue email when the payload carries it; otherwise try one
        // read (404 → nothing to flag, counted as skipped).
        let email = subType.includes("deletion") && ev.propertyName === "email" ? String(ev.propertyValue ?? "") : "";
        if (!email) {
          try {
            const contact = await client.getContact(objectId);
            email = String(contact.properties?.email ?? "");
          } catch (e) {
            if (isHubSpotStatus(e, 404)) {
              res.skipped += 1;
              continue;
            }
            throw e;
          }
        }
        const outcome = await flagInboundDeletion(email);
        if (outcome === "flagged") res.flagged += 1;
        else res.skipped += 1;
        res.processed += 1;
      } catch (e) {
        res.errors += 1;
        if (!res.lastErrorMessage) res.lastErrorMessage = e instanceof Error ? e.message : String(e);
        console.error(`[hubspot-webhook] deletion handling failed for object ${objectId}:`, e);
      }
    } else if (classifyContactEvent(subType) === "upsert") {
      try {
        // Fetch-then-upsert through the SAME inbound pipeline as the poller
        // (single source of truth in crm/sync.ts).
        const contact: HubSpotObject = await client.getContact(objectId);
        const outcome = await upsertInboundContact(contact);
        if (outcome === "created") res.created += 1;
        else if (outcome === "updated") res.updated += 1;
        else res.skipped += 1;
        res.processed += 1;
      } catch (e) {
        // 404 = contact gone between event and fetch — treat like a deletion
        // signal is impossible without the email, so count it skipped.
        if (isHubSpotStatus(e, 404)) {
          res.skipped += 1;
          res.processed += 1;
        } else {
          res.errors += 1;
          if (!res.lastErrorMessage) res.lastErrorMessage = e instanceof Error ? e.message : String(e);
          console.error(`[hubspot-webhook] upsert failed for object ${objectId}:`, e);
        }
      }
    } else {
      res.skipped += 1;
      continue;
    }
    if (eventId) {
      seenIds.add(eventId);
      newlySeen.push(eventId);
    }
  }

  await recordWebhookEventIds(newlySeen).catch((e) => {
    console.error("[hubspot-webhook] failed to record processed eventIds:", e);
  });
  // Refresh the inbound last_sync_at on completion — the polling cursor
  // (last_cursor) is NEVER touched here; it still belongs to the poller.
  try {
    const existing = await getSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts");
    if (existing) {
      await upsertSyncState(HUBSPOT_SYNC_PROVIDER, "inbound", "contacts", { lastSyncAt: Date.now() });
    }
  } catch (e) {
    console.error("[hubspot-webhook] failed to refresh inbound last_sync_at:", e);
  }
  return res;
}

export const hubspotWebhookRoutes = new Hono();

/**
 * GET verification path: HubSpot's subscription setup flow may request an
 * echo of a one-time verification token. Echoes `?token=` (or
 * `?verification_token=`) back as plain text; 400 when no token is present.
 */
hubspotWebhookRoutes.get("/hubspot", (c) => {
  const token = c.req.query("token") ?? c.req.query("verification_token") ?? "";
  if (!token) return c.json({ ok: true, message: "hubspot webhook endpoint — POST event batches here" }, 200);
  return c.text(token, 200);
});

/**
 * POST event batches. Order of checks (HubSpot retries 5xx aggressively,
 * so misconfiguration answers 200-with-skip, never 5xx):
 *   1. signature verify (secret set + bad/missing signature → 401);
 *   2. config gate (no key or CRM_PROVIDER != hubspot → 200 skipped, no
 *      DB writes, no HubSpot fetch);
 *   3. parse batch (array or single object) → process → 200 summary.
 */
hubspotWebhookRoutes.post(
  "/hubspot",
  async (c, next) => {
    // Capture the RAW body for signature verification before Hono parses it.
    const raw = await c.req.text();
    (c as unknown as { set: (k: string, v: unknown) => void }).set("rawBody", raw);
    await next();
  },
  async (c) => {
    const rawBody = (c as unknown as { get: (k: string) => unknown }).get("rawBody") as string;
    const signature = c.req.header("x-hubspot-signature") ?? "";
    const secret = resolveWebhookSecret();
    if (secret && !verifyHubSpotSignature(rawBody, signature, secret)) {
      console.error("[hubspot-webhook] signature mismatch — rejecting batch");
      return c.json({ error: "Invalid webhook signature" }, 401);
    }
    if (!secret) {
      console.log("[hubspot-webhook] no HUBSPOT_WEBHOOK_SECRET set — accepting unsigned (dev/dogfood default; production must set it)");
    }

    // Graceful unconfigured: never touch the DB or the network.
    // NOTE: env.hubspotApiKey reads only HUBSPOT_API_KEY, but the platform
    // injects the key as `Hubspot_API_key` (see hubspot-import.ts) — honor
    // the same fallback here so the dogfood tenant verifies live.
    if (!process.env.HUBSPOT_API_KEY && process.env.Hubspot_API_key) {
      process.env.HUBSPOT_API_KEY = process.env.Hubspot_API_key;
    }
    const cfg = resolveSyncConfig(undefined, process.env.CRM_PROVIDER ?? env.crmProvider);
    if (!cfg.ok) {
      console.log(`[hubspot-webhook] not configured (${cfg.reason}) — batch acknowledged without processing`);
      return c.json({ ok: true, skipped: "not_configured", reason: cfg.reason }, 200);
    }

    let events: HubSpotWebhookEvent[];
    try {
      const parsed: unknown = rawBody ? JSON.parse(rawBody) : [];
      events = (Array.isArray(parsed) ? parsed : [parsed]) as HubSpotWebhookEvent[];
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const client = (c as unknown as { get?: (k: string) => unknown }).get?.("hubspotClient") as HubSpotClient | undefined;
    const result = await processHubSpotWebhookEvents(client ?? cfg.client!, events);
    return c.json({ ok: true, ...result }, 200);
  }
);
