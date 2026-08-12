/**
 * CSV PROSPECT IMPORT (dogfooding Phase 1a — Chunk B).
 *
 * Shared import logic used by BOTH the API route (routes/import.ts) and the
 * ops script (scripts/import-prospects.ts). Pure repo/event-layer code — no
 * HTTP, no auth — so the production campaign import and the route exercise
 * exactly the same path.
 *
 * Column mapping is EXPLICIT here (one place, readable, auditable) for the
 * campaign CSV shape used by our Adrian, MI outbound list:
 *
 *   business_name -> lead name (firstName)      trade -> serviceRequested
 *   phone          -> phone (kept verbatim)     email -> email (when present)
 *   address+city+state+zip -> location          website -> notes ("Website: …")
 *   notes          -> appended to notes         source -> notes ("Source: …")
 *
 * Rows are created with source='prospect_import', status='new',
 * score='cold' (scoreValue 0). Every created row emits LEAD_CREATED (the same
 * event the create_lead tool emits) — the tenant's lead_created_welcome rule
 * materializes a run per row, and send_welcome skips leads without an active
 * conversation (verified in automations/actions.ts), so bulk import is quiet
 * and correct for cold prospects.
 *
 * Duplicates: a row is skipped when its phone or email already belongs to a
 * lead of this business (any source) OR was already created earlier in the
 * same file — re-importing the campaign CSV is a no-op.
 */
import * as repo from "../db/repo";
import { emitEvent } from "../ai/events";

export const PROSPECT_IMPORT_SOURCE = "prospect_import";

export interface ProspectImportRowResult {
  row: number; // 1-based data row (CSV line minus header)
  status: "created" | "skipped";
  reason?: string;
  leadId?: string;
  name?: string;
}

export interface ProspectImportResult {
  total: number;
  created: number;
  skipped: number;
  rows: ProspectImportRowResult[];
}

/** Minimal RFC-4180-ish CSV parser: handles quoted fields with embedded
 *  commas, escaped quotes (""), CRLF and LF. Kept deliberately small — the
 *  platform has no CSV dependency. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The campaign CSV header -> field mapping (kept explicit, per spec). */
const COLUMN = {
  businessName: "business_name",
  trade: "trade",
  address: "address",
  city: "city",
  state: "state",
  zip: "zip",
  phone: "phone",
  website: "website",
  notes: "notes",
  source: "source",
  email: "email", // not present in the Adrian file, but supported for future lists
} as const;

function cell(headers: string[], row: string[], name: string): string {
  const i = headers.indexOf(name);
  return i === -1 ? "" : (row[i] ?? "").trim();
}

export interface ProspectRow {
  name: string;
  phone: string;
  email: string;
  serviceRequested: string;
  location: string;
  notes: string;
}

/** Map one CSV row (values aligned with headers) to lead fields. */
export function mapProspectRow(headers: string[], row: string[]): ProspectRow {
  const address = cell(headers, row, COLUMN.address);
  const city = cell(headers, row, COLUMN.city);
  const state = cell(headers, row, COLUMN.state);
  const zip = cell(headers, row, COLUMN.zip);
  const website = cell(headers, row, COLUMN.website);
  const notes = cell(headers, row, COLUMN.notes);
  const source = cell(headers, row, COLUMN.source);

  const cityState = [city, state].filter(Boolean).join(", ");
  let location = address;
  if (cityState) location = location ? `${location}, ${cityState}` : cityState;
  if (zip) location = location ? `${location} ${zip}` : zip;
  location = location.slice(0, 120);
  const noteParts: string[] = [];
  if (website) noteParts.push(`Website: ${website}`);
  if (notes) noteParts.push(notes);
  if (source) noteParts.push(`Source: ${source}`);

  return {
    name: cell(headers, row, COLUMN.businessName),
    phone: cell(headers, row, COLUMN.phone),
    email: cell(headers, row, COLUMN.email),
    serviceRequested: cell(headers, row, COLUMN.trade).slice(0, 120),
    location,
    notes: noteParts.join("\n").slice(0, 4000),
  };
}

/**
 * Import prospects from CSV text into a tenant. Creates leads with
 * source='prospect_import' and emits LEAD_CREATED per created row.
 * Returns per-row outcomes; never throws for row-level issues (missing name,
 * duplicates) — those are reported as skipped.
 */
export async function importProspectCsv(businessId: string, csvText: string): Promise<ProspectImportResult> {
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return { total: rows.length, created: 0, skipped: 0, rows: [] };
  }
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  // Normalize common header aliases so hand-built campaign CSVs work too.
  const alias: Record<string, string> = {
    "business name": "business_name",
    name: "business_name",
    company: "business_name",
    "company name": "business_name",
    service: "trade",
    "service type": "trade",
    industry: "trade",
    "phone number": "phone",
    "phone #": "phone",
    "e-mail": "email",
    websiteurl: "website",
    url: "website",
  };
  const normalized = headers.map((h) => alias[h] ?? h);
  const nameIdx = normalized.indexOf(COLUMN.businessName);
  const phoneIdx = normalized.indexOf(COLUMN.phone);
  const emailIdx = normalized.indexOf(COLUMN.email);
  if (nameIdx === -1) {
    throw new Error(`CSV must have a "${COLUMN.businessName}" column (found: ${headers.join(", ") || "no headers"})`);
  }

  // Existing phone/email sets for dedupe (any source — a business already in
  // the platform must not be re-created).
  const existing = await repo.listLeads(businessId, 100_000);
  const phones = new Set(existing.map((l) => l.phone?.trim()).filter(Boolean));
  const emails = new Set(existing.map((l) => l.email?.trim().toLowerCase()).filter(Boolean));

  const results: ProspectImportRowResult[] = [];
  let createdCount = 0;
  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i];
    // Skip blank lines / fully-empty rows.
    if (!raw.some((c) => c.trim() !== "")) continue;
    const rowNum = i + 1;
    const mapped = mapProspectRow(normalized, raw);
    const fail = (reason: string, name?: string) => {
      results.push({ row: rowNum, status: "skipped", reason, name });
    };

    if (!mapped.name) {
      fail("missing-name");
      continue;
    }
    if (!mapped.phone && !mapped.email) {
      fail("no-contact");
      continue;
    }
    const phoneKey = mapped.phone.trim();
    const emailKey = mapped.email.trim().toLowerCase();
    if ((phoneKey && phones.has(phoneKey)) || (emailKey && emails.has(emailKey))) {
      fail("duplicate", mapped.name);
      continue;
    }

    const lead = await repo.createLead({
      businessId,
      firstName: mapped.name,
      lastName: "",
      phone: phoneKey,
      email: mapped.email,
      source: PROSPECT_IMPORT_SOURCE,
      serviceRequested: mapped.serviceRequested,
      location: mapped.location,
      notes: mapped.notes,
      status: "new",
      score: "cold",
      estimatedValueCents: 0,
    });
    if (!lead) {
      fail("create-failed", mapped.name);
      continue;
    }
    phones.add(phoneKey);
    if (emailKey) emails.add(emailKey);
    createdCount += 1;
    results.push({ row: rowNum, status: "created", leadId: lead.id, name: lead.firstName });
    // Same emission point as the create_lead tool (registry.ts) — drives the
    // lead_created_welcome rule; send_welcome skips no-conversation leads.
    await emitEvent({
      type: "LEAD_CREATED",
      businessId,
      leadId: lead.id,
      payload: { source: PROSPECT_IMPORT_SOURCE, firstName: lead.firstName },
    });
  }

  return {
    total: createdCount + results.filter((r) => r.status === "skipped").length,
    created: createdCount,
    skipped: results.filter((r) => r.status === "skipped").length,
    rows: results,
  };
}
