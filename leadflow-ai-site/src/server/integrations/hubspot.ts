/**
 * HubSpot CRM provider — real implementation behind the CrmProvider interface
 * (HubSpot ↔ LeadFlow record sync, Phase 1 task 1; scope doc §1, §3.1, §5).
 *
 * Two layers:
 *
 *   1. `HubSpotClient` — a thin plain-`fetch` wrapper over the HubSpot CRM v3
 *      REST API (https://api.hubapi.com, `Authorization: Bearer <token>`).
 *      Covers exactly the surface the record sync needs: contact
 *      create/PATCH/search, batch read/upsert, company search/create +
 *      contact→company association, and custom contact-property creation. It
 *      uses global `fetch` (no SDK dep — the @hubspot/api-client SDK adds
 *      ~500KB and is an esbuild/external risk for marginal gain, scope §5).
 *      `fetchImpl`/`baseUrl` are injectable so unit tests stay hermetic
 *      (canned JSON per URL, no network, no real keys).
 *
 *   2. `HubSpotCrmProvider` — implements the existing `CrmProvider` contract
 *      (`syncLead` / `updateLeadStatus`) from src/server/integrations/types.ts.
 *      Registered behind CRM_PROVIDER=hubspot; mock remains the default, so
 *      nothing talks to HubSpot until an operator sets BOTH CRM_PROVIDER=hubspot
 *      AND HUBSPOT_API_KEY — a config-only swap. Without a key, every call
 *      throws a clear "not configured" error (health check §40 stays correct).
 *
 * Field mapping (scope §3.1 — LeadFlow `leads` row ↔ HubSpot contact
 * properties; email is the join/dedupe key):
 *   email               ↔ email
 *   first_name/last_name↔ firstname / lastname
 *   phone               ↔ phone
 *   status              ↔ hs_lead_status      (values mapped 1:1, see map)
 *   score_value         ↔ lf_lead_score       (custom property)
 *   classification      ↔ lf_classification   (custom property)
 *   opted_out           ↔ lf_opted_out        (custom property)
 *   service_requested   ↔ lf_service_requested (custom property)
 *   location            ↔ lf_location         (custom property)
 *
 * The sync job (Phase 1 task 3) uses the extra client methods (search, batch,
 * company association, property creation); it is NOT built here.
 */
import type { CrmProvider, CrmLead } from "./types";
import { env } from "../env";

export const HUBSPOT_BASE_URL = "https://api.hubapi.com";
export const LF_PROPERTY_GROUP = "leadflow_ai";
/** Extra backfill-import contact properties (Phase 1 task 4). Stored in the
 *  same `leadflow_ai` property group; used by the one-time prospect import. */
export const LF_IMPORT_PROPERTY_KEY = "lf_import_key";
export const LF_IMPORT_PROPERTY_SOURCE = "lf_source_file";

const NOT_CONFIGURED =
  "CRM provider 'hubspot' is not configured — set HUBSPOT_API_KEY and CRM_PROVIDER=hubspot to enable it. " +
  "The mock provider (CRM_PROVIDER=mock, the default) keeps the app fully functional in the meantime.";

/** The contact properties we read back on search/get (our writes + write clocks). */
export const LF_CONTACT_READ_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "phone",
  "hs_lead_status",
  "lf_lead_score",
  "lf_classification",
  "lf_opted_out",
  "lf_service_requested",
  "lf_location",
  "hs_lastmodifieddate",
] as const;

// ---------------------------------------------------------------------------
// Errors + wire types
// ---------------------------------------------------------------------------

export class HubSpotApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`HubSpot API error ${status}: ${body.slice(0, 300)}`);
    this.name = "HubSpotApiError";
    this.status = status;
    this.body = body;
  }
}

export function isHubSpotError(e: unknown): e is HubSpotApiError {
  return e instanceof HubSpotApiError;
}

export function isHubSpotStatus(e: unknown, status: number): boolean {
  return isHubSpotError(e) && e.status === status;
}

export type HubSpotPropertyValue = string | number;

/** Contact/company properties as sent to HubSpot (strings for text/enum
 *  properties; numeric strings are accepted for number properties). */
export interface HubSpotProperties {
  [name: string]: HubSpotPropertyValue;
}

export interface HubSpotObject {
  id: string;
  properties?: Record<string, HubSpotPropertyValue | null | undefined>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  /** Present on some object reads; used for optimistic-concurrency PATCH retries. */
  version?: number;
  [key: string]: unknown;
}

export type HubSpotContact = HubSpotObject;
export type HubSpotCompany = HubSpotObject;

export interface HubSpotSearchFilter {
  propertyName: string;
  operator: string;
  value?: string | number;
  highValue?: string;
}

export interface HubSpotSearchRequest {
  filterGroups?: { filters: HubSpotSearchFilter[] }[];
  sorts?: string[];
  properties?: readonly string[];
  limit?: number;
  after?: number;
}

export interface HubSpotSearchResult<T extends HubSpotObject = HubSpotObject> {
  results: T[];
  total?: number;
  paging?: { next?: { after?: string; link?: string } };
}

// ---------------------------------------------------------------------------
// Custom contact properties (scope §3.1 — created once via
// POST /crm/v3/properties/contacts; deterministic, cheap)
// ---------------------------------------------------------------------------

export interface HubSpotPropertyDefinition {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
  description?: string;
}

export const LF_CONTACT_PROPERTIES = {
  lf_lead_score: {
    label: "LF Lead Score (0-100)",
    type: "number",
    fieldType: "number",
    description: "LeadFlow numeric 0-100 lead score (spec §9-11 rubric).",
  },
  lf_classification: {
    label: "LF Classification",
    type: "string",
    fieldType: "text",
    description: "LeadFlow rubric classification: HOT/WARM/COLD/UNQUALIFIED/HUMAN_REVIEW.",
  },
  lf_opted_out: {
    label: "LF Opted Out",
    type: "string",
    fieldType: "text",
    description: "LeadFlow follow-up opt-out marker (1 = opted out, 0 = not).",
  },
  lf_service_requested: {
    label: "LF Service Requested",
    type: "string",
    fieldType: "text",
    description: "LeadFlow service the lead asked about.",
  },
  lf_location: {
    label: "LF Location",
    type: "string",
    fieldType: "text",
    description: "LeadFlow lead service area / location.",
  },
  lf_import_key: {
    label: "LF Import Key (dedupe)",
    type: "string",
    fieldType: "text",
    description:
      "LeadFlow prospect-import stable dedupe key — email when present, else business Name|City|State.",
  },
  lf_source_file: {
    label: "LF Source File",
    type: "string",
    fieldType: "text",
    description: "LeadFlow prospect-import source (which market CSV the prospect came from).",
  },
} as const;

export type LfPropertyName = keyof typeof LF_CONTACT_PROPERTIES;

/** Deterministic creation payload for one custom contact property. */
export function lfContactPropertyDefinition(name: LfPropertyName): HubSpotPropertyDefinition {
  const def = LF_CONTACT_PROPERTIES[name];
  return {
    name,
    label: def.label,
    type: def.type,
    fieldType: def.fieldType,
    groupName: LF_PROPERTY_GROUP,
    description: def.description,
  };
}

// ---------------------------------------------------------------------------
// Field mapping (scope §3.1)
// ---------------------------------------------------------------------------

/** LeadFlow lead status → HubSpot standard `hs_lead_status` value (1:1). */
const LEAD_STATUS_MAP: Record<string, string> = {
  new: "NEW",
  contacted: "ATTEMPTED_TO_CONTACT",
  qualified: "IN_PROGRESS",
  appointment_booked: "OPEN_DEAL",
  customer: "CONNECTED",
  lost: "BAD_TIMING",
  unqualified: "UNQUALIFIED",
  needs_human: "OPEN",
};

export function toHubSpotLeadStatus(status: string): string {
  return LEAD_STATUS_MAP[status] ?? status.toUpperCase().replace(/[-\s]+/g, "_");
}

/**
 * LeadFlow `leads` row fields → HubSpot contact properties (scope §3.1).
 * Custom properties are only included when the caller supplies the value, so
 * a partial lead never overwrites HubSpot state it does not own.
 */
export function toHubSpotContactProperties(lead: CrmLead): HubSpotProperties {
  const p: HubSpotProperties = {
    email: lead.email,
    firstname: lead.firstName,
    lastname: lead.lastName,
    phone: lead.phone,
    hs_lead_status: toHubSpotLeadStatus(lead.status),
  };
  if (typeof lead.scoreValue === "number") p.lf_lead_score = String(lead.scoreValue);
  if (lead.classification) p.lf_classification = lead.classification;
  if (typeof lead.optedOut === "number") p.lf_opted_out = lead.optedOut ? "1" : "0";
  if (lead.serviceRequested) p.lf_service_requested = lead.serviceRequested;
  if (lead.location) p.lf_location = lead.location;
  return p;
}

// ---------------------------------------------------------------------------
// HubSpotClient — plain fetch, injectable for hermetic tests
// ---------------------------------------------------------------------------

export interface HubSpotClientOptions {
  /** Private App access token. Defaults to env.hubspotApiKey. */
  apiKey?: string;
  /** Base URL override (tests). Default https://api.hubapi.com */
  baseUrl?: string;
  /** fetch override (tests inject canned JSON per URL). Default global fetch. */
  fetchImpl?: typeof fetch;
}

export class HubSpotClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HubSpotClientOptions = {}) {
    // `??` on purpose: an explicitly-passed empty string must NOT fall through
    // to the environment (hermetic tests force no-key behavior).
    this.apiKey = (opts.apiKey ?? env.hubspotApiKey) ?? "";
    this.baseUrl = (opts.baseUrl ?? HUBSPOT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  private authorize(): void {
    if (!this.apiKey) throw new Error(NOT_CONFIGURED);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.authorize();
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`HubSpot network error: ${msg}`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new HubSpotApiError(res.status, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`HubSpot returned an unparseable response body (HTTP ${res.status})`);
    }
  }

  /** Raw GET for list endpoints that return `{results, paging}` (used by the
   *  prospect import to page through every contact/company once for the
   *  idempotency maps). */
  async listObjects<T extends HubSpotObject = HubSpotObject>(
    pathWithQuery: string
  ): Promise<{ results: T[]; paging?: { next?: { after?: string } } }> {
    return this.request("GET", pathWithQuery);
  }

  // --- Contacts -------------------------------------------------------------

  async createContact(properties: HubSpotProperties): Promise<HubSpotContact> {
    return this.request("POST", "/crm/v3/objects/contacts", { properties });
  }

  async getContact(contactId: string): Promise<HubSpotContact> {
    return this.request("GET", `/crm/v3/objects/contacts/${contactId}`);
  }

  /** PATCH a contact. `version` enables optimistic concurrency (409 when stale). */
  async updateContact(
    contactId: string,
    properties: HubSpotProperties,
    version?: number
  ): Promise<HubSpotContact> {
    const body: Record<string, unknown> = { properties };
    if (typeof version === "number") body.version = version;
    return this.request("PATCH", `/crm/v3/objects/contacts/${contactId}`, body);
  }

  /**
   * Update with the scope §3.1 conflict guard: PATCH → on 409 refetch the
   * fresh object → re-apply properties (via `reapply`, when given) → PATCH once
   * more with the fresh version. A second 409 throws for the caller to handle
   * (drop a human task, Phase 2).
   */
  async updateContactWithConflictRetry(
    contactId: string,
    properties: HubSpotProperties,
    reapply?: (fresh: HubSpotContact) => HubSpotProperties
  ): Promise<HubSpotContact> {
    try {
      return await this.updateContact(contactId, properties);
    } catch (e) {
      if (!isHubSpotStatus(e, 409)) throw e;
    }
    // 409 — concurrent modification: refetch, re-apply, retry once.
    const fresh = await this.getContact(contactId);
    const retryProps = reapply ? reapply(fresh) : properties;
    return this.updateContact(contactId, retryProps, typeof fresh.version === "number" ? fresh.version : undefined);
  }

  /** Search contacts — the dedupe primitive (scope §1.2). */
  async searchContacts(req: HubSpotSearchRequest): Promise<HubSpotSearchResult<HubSpotContact>> {
    return this.request("POST", "/crm/v3/objects/contacts/search", req);
  }

  /** Search for ONE contact by exact email — null when absent. */
  async searchContactsByEmail(email: string): Promise<HubSpotContact | null> {
    const res = await this.searchContacts({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      limit: 1,
      properties: LF_CONTACT_READ_PROPERTIES,
    });
    return res.results[0] ?? null;
  }

  /** Batch read by email (≤100) — the efficient initial-sync dedupe path. */
  async batchReadContactsByEmail(emails: string[]): Promise<HubSpotContact[]> {
    const res = await this.request<{ results: HubSpotContact[] }>(
      "POST",
      "/crm/v3/objects/contacts/batch/read",
      { inputs: emails.map((email) => ({ id: email })), idProperty: "email" }
    );
    return res.results;
  }

  /** Batch create-or-update keyed by email (≤100) — the efficient bulk path. */
  async batchUpsertContacts(
    records: { email: string; properties: HubSpotProperties }[]
  ): Promise<HubSpotContact[]> {
    const res = await this.request<{ results: HubSpotContact[] }>(
      "POST",
      "/crm/v3/objects/contacts/batch/upsert",
      { inputs: records.map((r) => ({ id: r.email, properties: r.properties })), idProperty: "email" }
    );
    return res.results;
  }

  /** Batch create contacts (≤100) — used by the prospect import for email-less
   *  rows (dedupe key is the lf_import_key custom property, not email). */
  async batchCreateContacts(records: { properties: HubSpotProperties }[]): Promise<HubSpotContact[]> {
    const res = await this.request<{ results: HubSpotContact[] }>(
      "POST",
      "/crm/v3/objects/contacts/batch/create",
      { inputs: records.map((r) => ({ properties: r.properties })) }
    );
    return res.results;
  }

  /** Batch create companies (≤100) — used by the prospect import. */
  async batchCreateCompanies(records: { properties: HubSpotProperties }[]): Promise<HubSpotCompany[]> {
    const res = await this.request<{ results: HubSpotCompany[] }>(
      "POST",
      "/crm/v3/objects/companies/batch/create",
      { inputs: records.map((r) => ({ properties: r.properties })) }
    );
    return res.results;
  }

  // --- Companies ------------------------------------------------------------

  async createCompany(properties: HubSpotProperties): Promise<HubSpotCompany> {
    return this.request("POST", "/crm/v3/objects/companies", { properties });
  }

  /** PATCH a company's properties (import-time domain enrichment). */
  async updateCompany(companyId: string, properties: HubSpotProperties): Promise<HubSpotCompany> {
    return this.request("PATCH", `/crm/v3/objects/companies/${companyId}`, { properties });
  }

  /** Search for ONE company by domain — null when absent. */
  async searchCompaniesByDomain(domain: string): Promise<HubSpotCompany | null> {
    const res = await this.request<HubSpotSearchResult<HubSpotCompany>>(
      "POST",
      "/crm/v3/objects/companies/search",
      {
        filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }],
        limit: 1,
        properties: ["domain", "name", "phone"],
      }
    );
    return res.results[0] ?? null;
  }

  /** Search for ONE company by exact name — null when absent. */
  async searchCompaniesByName(name: string): Promise<HubSpotCompany | null> {
    const res = await this.request<HubSpotSearchResult<HubSpotCompany>>(
      "POST",
      "/crm/v3/objects/companies/search",
      {
        filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: name }] }],
        limit: 1,
        properties: ["domain", "name", "phone"],
      }
    );
    return res.results[0] ?? null;
  }

  /** Read companies by id (≤100) — used to re-check `domain` on a company
   *  that was found by name so the email-dedupe path only matches verified
   *  same-domain companies. */
  async batchReadCompaniesByIds(ids: string[]): Promise<HubSpotCompany[]> {
    const res = await this.request<{ results: HubSpotCompany[] }>(
      "POST",
      "/crm/v3/objects/companies/batch/read",
      { inputs: ids.map((id) => ({ id })), idProperty: "id" }
    );
    return res.results;
  }

  /** Link a contact to a company (contact belongs-to company). */
  async associateContactToCompany(contactId: string, companyId: string): Promise<void> {
    await this.request("PUT", `/crm/v3/objects/contacts/${contactId}/associations/companies/${companyId}`);
  }

  /** Search for ONE contact by exact value in a custom text property
   *  (`lf_import_key`, `lf_source_file`, …) — null when absent. */
  async searchContactsByProperty(propertyName: string, value: string): Promise<HubSpotContact | null> {
    const res = await this.searchContacts({
      filterGroups: [{ filters: [{ propertyName, operator: "EQ", value }] }],
      limit: 1,
      properties: [...LF_CONTACT_READ_PROPERTIES, "lf_import_key", "lf_source_file"],
    });
    return res.results[0] ?? null;
  }

  /** Batch create-or-update contacts keyed by a custom dedupe property
   *  (`lf_import_key`), for idempotent bulk import of rows that may lack an
   *  email. Each record must carry that property in `properties`. */
  async batchUpsertContactsByProperty(
    propertyName: string,
    records: { key: string; properties: HubSpotProperties }[]
  ): Promise<HubSpotContact[]> {
    const res = await this.request<{ results: HubSpotContact[] }>(
      "POST",
      "/crm/v3/objects/contacts/batch/upsert",
      {
        inputs: records.map((r) => ({
          id: `${LF_PROPERTY_GROUP}-${r.key}`,
          idProperty: propertyName,
          properties: r.properties,
        })),
        idProperty: propertyName,
      }
    );
    return res.results;
  }

  // --- Custom properties ----------------------------------------------------

  /**
   * Create the `leadflow_ai` property group on contacts if absent, then create
   * the LeadFlow custom contact properties (scope §3.1 + the two backfill
   * import props). Idempotent: a 409 "already exists" per property/group is
   * treated as success. Returns the names that were ensured.
   */
  async ensureContactProperties(): Promise<string[]> {
    const ensured: string[] = [];
    try {
      await this.request("POST", "/crm/v3/properties/contacts/groups", {
        name: LF_PROPERTY_GROUP,
        label: "LeadFlow AI",
        displayOrder: 0,
      });
      ensured.push(`group:${LF_PROPERTY_GROUP}`);
    } catch (e) {
      if (!isHubSpotStatus(e, 409)) throw e; // group already exists → fine
    }
    const names = Object.keys(LF_CONTACT_PROPERTIES) as LfPropertyName[];
    for (const name of names) {
      try {
        await this.request("POST", "/crm/v3/properties/contacts", lfContactPropertyDefinition(name));
        ensured.push(name);
      } catch (e) {
        if (!isHubSpotStatus(e, 409)) throw e; // property already exists → fine
      }
    }
    return ensured;
  }
}

// ---------------------------------------------------------------------------
// HubSpotCrmProvider — behind the existing CrmProvider interface
// ---------------------------------------------------------------------------

export interface HubSpotCrmProviderOptions extends HubSpotClientOptions {}

export class HubSpotCrmProvider implements CrmProvider {
  readonly name = "hubspot";
  private readonly opts: HubSpotCrmProviderOptions;

  constructor(opts: HubSpotCrmProviderOptions = {}) {
    this.opts = opts;
  }

  /** Lazily-create the client. Throws NOT_CONFIGURED when no key is set. */
  client(): HubSpotClient {
    return new HubSpotClient(this.opts);
  }

  /** Create the custom contact properties (idempotent) — the sync job calls
   *  this once at startup so later writes never 400 on unknown properties. */
  async ensureContactProperties(): Promise<string[]> {
    return this.client().ensureContactProperties();
  }

  /**
   * Dedupe by email (search) → create when absent, PATCH with the scope §3.1
   * mapping (+ 409 conflict-guard retry) when present. Requires a lead email:
   * it is the HubSpot join key. Returns the HubSpot contact id as externalId.
   */
  async syncLead(lead: CrmLead): Promise<{ ok: true; externalId: string }> {
    if (!lead.email) {
      throw new Error("HubSpot sync requires a lead email — it is the HubSpot dedupe key (scope §3.1).");
    }
    const client = this.client();
    const props = toHubSpotContactProperties(lead);
    const existing = await client.searchContactsByEmail(lead.email);
    if (!existing) {
      const created = await client.createContact(props);
      return { ok: true, externalId: created.id };
    }
    await client.updateContactWithConflictRetry(existing.id, props, () => toHubSpotContactProperties(lead));
    return { ok: true, externalId: existing.id };
  }

  /**
   * Set the HubSpot lead-status property. `contactId` is the HUBSPOT contact
   * id (numeric) — Phase 1 task 3 wires leads.hubspot_contact_id through here.
   */
  async updateLeadStatus(contactId: string, status: string): Promise<{ ok: true }> {
    await this.client().updateContact(contactId, { hs_lead_status: toHubSpotLeadStatus(status) });
    return { ok: true as const };
  }
}