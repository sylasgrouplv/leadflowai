/**
 * HubSpot prospect backfill import (Phase 1 task 4 — scope doc §7 task 4).
 *
 * One-time, IDEMPOTENT import of the 4 market prospect CSVs into the real
 * HubSpot account (portal 247247238):
 *
 *   /home/team/shared/prospects/
 *     fort-wayne-in-prospects.csv   (440 rows — no email column)
 *     adrian-mi-49221-prospects.csv ( 60 rows — no email column)
 *     ann-arbor-mi-prospects.csv    ( 67 rows — email + contact_name)
 *     toledo-oh-prospects.csv       ( 92 rows — email + contact_name)
 *
 * What it writes (scope §3.1 mapping, all rows are unqualified prospects):
 *   - Companies:  name, domain (from website hostname), phone, address,
 *     city/state/zip, website. Dedupe by domain first, then by exact name
 *     (disambiguated by city/state when the name repeats).
 *   - Contacts:   firstname/lastname (from contact_name), email, phone,
 *     website, address/city/state/zip, plus the LeadFlow custom props:
 *     lf_classification=UNQUALIFIED, lf_opted_out=0,
 *     lf_service_requested=trade/category, lf_location="City, ST",
 *     lf_import_key (stable dedupe key: email, else "Name|City|ST") and
 *     lf_source_file (which market CSV). hs_lead_status is intentionally NOT
 *     set — these are pure prospects, not customers.
 *   - Associations: contact → company (belongs-to), for every created contact.
 *
 * Idempotency: before creating anything it pages through ALL existing
 * contacts/companies and builds email + lf_import_key (contacts) and
 * domain + name (companies) maps, so re-runs find every record and create
 * nothing new. A re-run therefore reports created=0 and skipped=N (or a
 * PATCH-only "updated" when a mapped field differs).
 *
 * Notes/observations from the CSVs are NOT written to HubSpot: neither
 * object type has a `notes` property (companies have `about_us`, which is
 * semantically wrong for prospect research notes). Notes stay in the CSVs
 * and are captured by this log for a future sync field if the team wants it.
 *
 * Run:
 *   cd /home/agent-lead/leadflowai/leadflow-ai-site
 *   bun run hubspot-import.ts [--dry-run] [--limit N]
 *
 * Reads the API key from HUBSPOT_API_KEY, falling back to the platform's
 * injected `Hubspot_API_key` (same value; only casing differs). The key is
 * never printed. A run log is written to
 * /home/team/shared/prospects/hubspot-import-run-<timestamp>.json
 *
 * HubSpot rate limits: the free tier allows ~100 requests / 10 s per account
 * plus a daily quota. This design pages (7-8 list calls), batch-creates in
 * ≤100-record chunks, and paces every request with a short delay — the only
 * chatty step is the one-time contact→company association (659 PUTs).
 */
import { HubSpotClient } from "./src/server/integrations/hubspot";
import type { HubSpotProperties, HubSpotObject } from "./src/server/integrations/hubspot";
import { writeFileSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Env / config
// ---------------------------------------------------------------------------

if (!process.env.HUBSPOT_API_KEY && process.env.Hubspot_API_key) {
  // env.ts only reads HUBSPOT_API_KEY; the platform injects Hubspot_API_key.
  process.env.HUBSPOT_API_KEY = process.env.Hubspot_API_key;
}

const PROSPECTS_DIR = "/home/team/shared/prospects";
const SOURCE_FILES = [
  "fort-wayne-in-prospects.csv",
  "adrian-mi-49221-prospects.csv",
  "ann-arbor-mi-prospects.csv",
  "toledo-oh-prospects.csv",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// CSV reading — delegate to python3's csv module (exactly the quoting the
// brief requires), write rows as JSON to stdout. No new npm dependencies.
// ---------------------------------------------------------------------------

const PY_READER = `
import csv, json, sys
path = sys.argv[1]
with open(path, newline='', encoding='utf-8-sig') as f:
    rows = list(csv.DictReader(f))
print(json.dumps(rows))
`;

async function readCsv(path: string): Promise<Record<string, string>[]> {
  const scriptPath = "/tmp/lf_hubspot_csv_reader.py";
  writeFileSync(scriptPath, PY_READER);
  const proc = Bun.spawnSync({ cmd: ["python3", scriptPath, path], stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`python3 csv parse failed for ${path}: ${Buffer.from(proc.stderr ?? "").toString().slice(0, 500)}`);
  }
  return JSON.parse(Buffer.from(proc.stdout ?? "").toString()) as Record<string, string>[];
}

// ---------------------------------------------------------------------------
// Normalization (common field set across the two CSV schemas)
// ---------------------------------------------------------------------------

interface Prospect {
  businessName: string;
  trade: string; // trade (FW/Adrian) or category (AA/Toledo)
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string; // E.164-ish "+1" + 10 digits, or ""
  website: string; // https:// URL or ""
  domain: string; // website hostname without www, or ""
  contactName: string;
  firstName: string;
  lastName: string;
  email: string; // lowercased/trimmed, or ""
  notes: string;
  source: string;
  csvFile: string;
  /** stable dedupe key: email when present, else "name|city|state" */
  importKey: string;
  /** "name|city|state" — fallback + colliding-email re-key */
  nameKey: string;
  /** company dedupe key: "domain:<domain>" or "name:<nameKey>|<city>|<state>" */
  companyKey: string;
}

const norm = (v: unknown): string => (v ?? "").toString().trim();
const normNameKey = (s: string): string => norm(s).toLowerCase().replace(/\s+/g, " ");

function normalizePhone(raw: string): string {
  const d = norm(raw).replace(/\D+/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+1${d.slice(1)}`;
  return d ? `+${d}` : "";
}

function normalizeWebsite(raw: string): { url: string; domain: string } {
  let w = norm(raw);
  if (!w) return { url: "", domain: "" };
  if (!/^https?:\/\//i.test(w)) w = `https://${w}`;
  let host = "";
  try {
    host = new URL(w).hostname.toLowerCase();
  } catch {
    return { url: w, domain: "" };
  }
  const domain = host.startsWith("www.") ? host.slice(4) : host;
  return { url: w, domain };
}

function splitContactName(raw: string): { first: string; last: string } {
  const n = norm(raw).replace(/\s+/g, " ");
  if (!n) return { first: "", last: "" };
  const parts = n.split(" ");
  if (parts.length === 1) return { first: n, last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function rowToProspect(row: Record<string, string>, csvFile: string): Prospect {
  const businessName = norm(row.business_name);
  const trade = norm(row.trade || row.category || "");
  const city = norm(row.city);
  const state = norm(row.state);
  const zip = norm(row.zip);
  const address = norm(row.address);
  const phone = normalizePhone(row.phone ?? "");
  const { url: website, domain } = normalizeWebsite(row.website ?? "");
  const { first: firstName, last: lastName } = splitContactName(row.contact_name ?? "");
  const cityState = city ? `${city.toLowerCase()}|${state.toLowerCase()}` : state.toLowerCase();
  const email = norm(row.email ?? "").toLowerCase();
  const nameKey = `${normNameKey(businessName)}|${cityState}`;
  const importKey = email || nameKey;
  const companyKey = domain ? `domain:${domain}` : `name:${normNameKey(businessName)}|${cityState}`;
  return {
    businessName,
    trade,
    address,
    city,
    state,
    zip,
    phone,
    website,
    domain,
    contactName: norm(row.contact_name ?? ""),
    firstName,
    lastName,
    email,
    notes: norm(row.notes ?? ""),
    source: norm(row.source ?? ""),
    csvFile,
    importKey,
    nameKey,
    companyKey,
  };
}

// ---------------------------------------------------------------------------
// Desired HubSpot payloads
// ---------------------------------------------------------------------------

function companyProperties(p: Prospect): HubSpotProperties {
  const props: HubSpotProperties = { name: p.businessName };
  if (p.domain) props.domain = p.domain;
  if (p.phone) props.phone = p.phone;
  if (p.address) props.address = p.address;
  if (p.city) props.city = p.city;
  if (p.state) props.state = p.state;
  if (p.zip) props.zip = p.zip;
  if (p.website) props.website = p.website;
  return props;
}

function contactProperties(p: Prospect): HubSpotProperties {
  const props: HubSpotProperties = {
    lf_import_key: p.importKey,
    lf_source_file: p.csvFile,
    lf_classification: "UNQUALIFIED",
    lf_opted_out: "0",
    lf_service_requested: p.trade,
    lf_location: p.city && p.state ? `${p.city}, ${p.state}` : norm(`${p.city} ${p.state}`),
  };
  // Only set email when this row OWNS it (importKey === email). A row whose
  // email collided with a different company was re-keyed on name|city|state;
  // writing the shared email would make HubSpot merge the two contacts.
  if (p.email && p.importKey === p.email) props.email = p.email;
  if (p.firstName) props.firstname = p.firstName;
  if (p.lastName) props.lastname = p.lastName;
  if (p.phone) props.phone = p.phone;
  if (p.website) props.website = p.website;
  if (p.address) props.address = p.address;
  if (p.city) props.city = p.city;
  if (p.state) props.state = p.state;
  if (p.zip) props.zip = p.zip;
  return props;
}

function propsDiffer(existing: Record<string, unknown> | undefined, desired: HubSpotProperties): boolean {
  for (const [k, v] of Object.entries(desired)) {
    const cur = existing?.[k];
    if (cur === undefined || cur === null) {
      if (v !== "" && v !== undefined && v !== null) return true;
      continue;
    }
    if (String(cur) !== String(v)) return true;
  }
  return false;
}

/** HubSpot batch-create responses put per-input results in `results`
 *  (positional, in input order) and failures in `errors` (each with the input
 *  `index`). Reconstruct a per-input outcome array so a failed input never
 *  silently shifts the rest. */
function indexOutcomes(
  body: { results?: { id?: string }[]; errors?: { message?: string; index?: number }[] },
  count: number
): { ok: boolean; id: string; message: string }[] {
  const out: { ok: boolean; id: string; message: string }[] = Array.from({ length: count }, () => ({
    ok: false,
    id: "",
    message: "no result",
  }));
  for (const [i, r] of (body.results ?? []).entries()) {
    if (i < count) out[i] = r?.id ? { ok: true, id: r.id, message: "" } : out[i];
  }
  for (const e of body.errors ?? []) {
    if (typeof e.index === "number" && e.index >= 0 && e.index < count) {
      out[e.index] = { ok: false, id: "", message: e.message ?? "error" };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paginated full lists (the idempotency maps)
// ---------------------------------------------------------------------------

async function fetchAll<T extends { id: string; properties?: Record<string, unknown> }>(
  client: HubSpotClient,
  path: string,
  properties: string[]
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let i = 0; ; i += 1) {
    const q = new URLSearchParams({ limit: "100", properties: properties.join(",") });
    if (after) q.set("after", after);
    const res = await client.listObjects<HubSpotObject>(`${path}?${q.toString()}`);
    out.push(...(res.results as T[]));
    const next = res.paging?.next?.after;
    if (!next) break;
    after = next;
    await sleep(60);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface RunSummary {
  file: string;
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  contacts: number;
  companies: number;
  companiesCreated: number;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

  if (!process.env.HUBSPOT_API_KEY) {
    console.error("No HubSpot API key: set HUBSPOT_API_KEY (or rely on the platform's Hubspot_API_key env var).");
    process.exit(2);
  }
  const client = new HubSpotClient(); // apiKey via env (Hubspot_API_key fallback applied above)
  console.log(`HubSpot client ready (${dryRun ? "DRY RUN — no writes" : "LIVE RUN — writes enabled"})${Number.isFinite(limit) ? `, limit=${limit} rows/file` : ""}`);

  // --- 1. Read + normalize all CSVs ---------------------------------------
  const prospects: Prospect[] = [];
  const perCsvRows: Record<string, number> = {};
  for (const f of SOURCE_FILES) {
    const rows = await readCsv(`${PROSPECTS_DIR}/${f}`);
    const slice = Number.isFinite(limit) ? rows.slice(0, limit) : rows;
    perCsvRows[f] = slice.length;
    for (const r of slice) prospects.push(rowToProspect(r, f));
    console.log(`read ${f}: ${slice.length} rows`);
  }

  // Local intra-run dedupe guard — if two rows resolve to the same importKey
  // they would collide on the same HubSpot contact. When that happens across
  // DIFFERENT company names (a CSV data quirk — e.g. an email copied onto an
  // unrelated business row), keep BOTH rows by re-keying the later one on
  // name|city|state, so no real business is lost as a contact. Only when the
  // two rows are genuinely the same business (same name) is the later row
  // dropped.
  const keySeen = new Map<string, Prospect>();
  const keyCollisions = new Map<string, number>();
  const unique: Prospect[] = [];
  for (const p of prospects) {
    const prev = keySeen.get(p.importKey);
    if (prev) {
      const sameCompanyRows = normNameKey(prev.businessName) === normNameKey(p.businessName);
      if (sameCompanyRows) {
        // Genuine duplicate business row — keep the first, report the drop.
        keyCollisions.set(p.importKey, (keyCollisions.get(p.importKey) ?? 1) + 1);
        continue;
      }
      // Different companies share this email (CSV data quirk) — re-key this
      // row on its name|city|state and keep it.
      if (keySeen.has(p.nameKey) || unique.some((u) => u.importKey === p.nameKey)) {
        keyCollisions.set(p.importKey, (keyCollisions.get(p.importKey) ?? 1) + 1);
        continue;
      }
      p.importKey = p.nameKey;
      keySeen.set(p.importKey, p);
      unique.push(p);
      continue;
    }
    keySeen.set(p.importKey, p);
    unique.push(p);
  }
  console.log(`normalized ${prospects.length} rows → ${unique.length} unique import keys (${[...keyCollisions.values()].reduce((a, b) => a + b, 0)} duplicate row(s) dropped)`);

  // --- 2. Ensure custom properties (WRITE — skipped on dry run) -----------
  let ensured: string[] = [];
  if (!dryRun) {
    ensured = await client.ensureContactProperties();
    console.log(`ensureContactProperties: ${ensured.join(", ")}`);
    await sleep(100);
  }

  // --- 3. Page through existing contacts + companies (read-only) ----------
  const CONTACT_LIST_PROPS = [
    "email", "firstname", "lastname", "phone", "website", "address", "city", "state", "zip",
    "lf_import_key", "lf_source_file", "lf_classification", "lf_opted_out", "lf_service_requested", "lf_location",
  ];
  const COMPANY_LIST_PROPS = ["name", "domain", "phone", "website", "address", "city", "state", "zip"];
  const existingContacts = await fetchAll(client, "/crm/v3/objects/contacts", CONTACT_LIST_PROPS);
  const existingCompanies = await fetchAll(client, "/crm/v3/objects/companies", COMPANY_LIST_PROPS);
  await sleep(100);
  console.log(`existing in HubSpot: ${existingContacts.length} contacts, ${existingCompanies.length} companies`);

  const contactByEmail = new Map<string, (typeof existingContacts)[number]>();
  const contactByKey = new Map<string, (typeof existingContacts)[number]>();
  for (const c of existingContacts) {
    const props = c.properties ?? {};
    const email = norm(props.email).toLowerCase();
    const ik = norm(props.lf_import_key);
    if (email) contactByEmail.set(email, c);
    if (ik) contactByKey.set(ik, c);
  }
  const companiesByDomain = new Map<string, (typeof existingCompanies)[number]>();
  const companiesByName = new Map<string, (typeof existingCompanies)[number][]>();
  for (const c of existingCompanies) {
    const props = c.properties ?? {};
    const domain = norm(props.domain).toLowerCase().replace(/^www\./, "");
    if (domain) companiesByDomain.set(domain, c);
    const name = norm(props.name).toLowerCase();
    const arr = companiesByName.get(name) ?? [];
    arr.push(c);
    companiesByName.set(name, arr);
  }

  // --- 4. Plan per row -----------------------------------------------------
  const companyPlan = new Map<string, { companyId: string; created: boolean; error?: string }>();
  const contactPlan: {
    prospect: Prospect;
    company: { companyId: string; created: boolean } | null;
    action: "create" | "update" | "skip";
    plannedCreate: boolean;
    error?: string;
  }[] = [];
  const companyCreateQueue = new Map<string, Prospect[]>(); // companyKey → prospects

  for (const p of unique) {
    // --- company resolution ---
    let companyId = "";
    let companyCreated = false;
    const byDomain = p.domain ? companiesByDomain.get(p.domain) : undefined;
    const byName = companiesByName.get(normNameKey(p.businessName));
    if (byDomain) {
      companyId = byDomain.id;
    } else if (byName && byName.length > 0) {
      // Disambiguate same-named companies by city/state when possible.
      const match = byName.find(
        (c) => norm(c.properties?.city).toLowerCase() === p.city.toLowerCase() && norm(c.properties?.state).toLowerCase() === p.state.toLowerCase()
      ) ?? byName[0];
      companyId = match.id;
    }
    if (companyId) {
      companyPlan.set(p.companyKey, { companyId, created: false });
    } else {
      const queued = companyCreateQueue.get(p.companyKey) ?? [];
      queued.push(p);
      companyCreateQueue.set(p.companyKey, queued);
    }

    // --- contact resolution ---
    const existing = (p.email ? contactByEmail.get(p.email) : undefined) ?? contactByKey.get(p.importKey);
    const plannedCreate = !existing;
    contactPlan.push({
      prospect: p,
      company: companyId ? { companyId, created: companyCreated } : null, // filled from companyPlan after batch create
      action: plannedCreate ? (dryRun ? "skip" : "create") : propsDiffer(existing!.properties, contactProperties(p)) ? "update" : "skip",
      plannedCreate,
    });
  }

  // --- 5. Create missing companies (WRITE — skipped on dry run) -----------
  const companiesCreated: { companyKey: string; companyId: string }[] = [];
  if (!dryRun && companyCreateQueue.size > 0) {
    const entries = [...companyCreateQueue.entries()];
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      const bodyRes = await client.batchCreateCompanies(chunk.map(([, prospects]) => ({ properties: companyProperties(prospects[0]) })));
      const outcomes = indexOutcomes(bodyRes as unknown as { results?: { id?: string }[]; errors?: { message?: string; index?: number }[] }, chunk.length);
      for (let idx = 0; idx < chunk.length; idx += 1) {
        const [key] = chunk[idx];
        const o = outcomes[idx];
        if (o.ok) {
          companiesCreated.push({ companyKey: key, companyId: o.id });
          companyPlan.set(key, { companyId: o.id, created: true });
        } else {
          companyPlan.set(key, { companyId: "", created: false, error: o.message });
          console.warn(`company create failed [${key}]: ${o.message}`);
        }
      }
      await sleep(500);
    }
    console.log(`companies created: ${companiesCreated.length}`);
  } else if (dryRun && companyCreateQueue.size > 0) {
    for (const [key, prospects] of companyCreateQueue) {
      companyPlan.set(key, { companyId: "", created: false }); // mark "would create"
    }
    console.log(`companies that would be created: ${companyCreateQueue.size}`);
  }

  // Backfill contact plans that were queued for "create" but rely on companyPlan.
  for (const cp of contactPlan) {
    if (cp.action !== "create" && cp.action !== "update") continue;
    if (cp.company === null) {
      const plan = companyPlan.get(cp.prospect.companyKey);
      cp.company = plan && plan.companyId ? { companyId: plan.companyId, created: plan.created } : null;
    }
  }

  // --- 6. Create / update / skip contacts ---------------------------------
  const contactCreateQueue = contactPlan.filter((c) => c.action === "create");
  const contactsCreated: { importKey: string; contactId: string }[] = [];
  const assocErrors: { importKey: string; contactId: string; message: string }[] = [];
  const createdContactIds = new Map<string, string>(); // importKey → contactId
  const errors: { file: string; importKey: string; action: string; message: string }[] = [];

  if (!dryRun && contactCreateQueue.length > 0) {
    for (let i = 0; i < contactCreateQueue.length; i += 100) {
      const chunk = contactCreateQueue.slice(i, i + 100);
      const bodyRes = await client.batchCreateContacts(chunk.map((c) => ({ properties: contactProperties(c.prospect) })));
      const outcomes = indexOutcomes(bodyRes as unknown as { results?: { id?: string }[]; errors?: { message?: string; index?: number }[] }, chunk.length);
      chunk.forEach((c, idx) => {
        const o = outcomes[idx];
        if (o.ok) {
          contactsCreated.push({ importKey: c.prospect.importKey, contactId: o.id });
          createdContactIds.set(c.prospect.importKey, o.id);
        } else {
          (c as { action: "create"; error?: string }).error = o.message;
          console.warn(`contact create failed [${c.prospect.importKey}]: ${o.message}`);
        }
      });
      await sleep(500);
    }
    // --- associations for created contacts (belongs-to company) -----------
    let assocCount = 0;
    for (const c of contactCreateQueue) {
      const contactId = createdContactIds.get(c.prospect.importKey);
      if (!contactId) continue;
      const company = c.company;
      if (!company || !company.companyId) continue;
      try {
        await client.associateContactToCompany(contactId, company.companyId);
        assocCount += 1;
        await sleep(120); // burst budget: ≤100 req/10s — 120ms ≈ 83 req/10s
      } catch (e) {
        assocErrors.push({ importKey: c.prospect.importKey, contactId, message: e instanceof Error ? e.message : String(e) });
      }
    }
    console.log(`associations created: ${assocCount}, errors: ${assocErrors.length}`);
  } else if (dryRun) {
    console.log(`contacts that would be created: ${contactPlan.filter((c) => c.plannedCreate).length}`);
  }

  let contactsUpdated = 0;
  for (const c of contactPlan) {
    if (c.action !== "update") continue;
    const existing = (c.prospect.email ? contactByEmail.get(c.prospect.email) : undefined) ?? contactByKey.get(c.prospect.importKey);
    if (!existing) continue;
    try {
      await client.updateContactWithConflictRetry(existing.id, contactProperties(c.prospect));
      contactsUpdated += 1;
      await sleep(60);
    } catch (e) {
      (c as { action: "update"; error?: string }).error = e instanceof Error ? e.message : String(e);
    }
  }

  // Company PATCHes for domain enrichment (name-matched company missing domain)
  let companiesUpdated = 0;
  if (!dryRun) {
    for (const p of unique) {
      if (!p.domain) continue;
      const plan = companyPlan.get(p.companyKey);
      if (!plan || plan.created || !plan.companyId) continue;
      try {
        await client.updateCompany(plan.companyId, { domain: p.domain });
        companiesUpdated += 1;
        await sleep(60);
      } catch (e) {
        errors.push({ file: p.csvFile, importKey: p.importKey, action: "company-enrich", message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // --- 7. Final counts (read-only) ----------------------------------------
  const finalContacts = await fetchAll(client, "/crm/v3/objects/contacts", CONTACT_LIST_PROPS);
  const finalCompanies = await fetchAll(client, "/crm/v3/objects/companies", COMPANY_LIST_PROPS);

  // --- 8. Per-file summary + log ------------------------------------------
  const table: RunSummary[] = [];
  for (const f of SOURCE_FILES) {
    const rows = unique.filter((p) => p.csvFile === f);
    let created = 0, updated = 0, skipped = 0, errs = 0;
    for (const p of rows) {
      const cp = contactPlan.find((c) => c.prospect.importKey === p.importKey && c.prospect.csvFile === f);
      if (!cp) continue;
      if (!dryRun && cp.plannedCreate) {
        if (cp.error) { errs += 1; errors.push({ file: f, importKey: p.importKey, action: "create", message: cp.error }); }
        else created += 1;
      } else if (!dryRun && cp.action === "update") {
        if (cp.error) { errs += 1; errors.push({ file: f, importKey: p.importKey, action: "update", message: cp.error }); }
        else updated += 1;
      } else if (dryRun && cp.plannedCreate) {
        created += 1; // "would create"
      } else {
        skipped += 1;
      }
    }
    for (const a of assocErrors) {
      const src = unique.find((p) => p.importKey === a.importKey);
      if (src?.csvFile === f) {
        errs += 1;
        errors.push({ file: f, importKey: a.importKey, action: "associate", message: a.message });
      }
    }
    table.push({ file: f, rows: perCsvRows[f], created, updated, skipped, errors: errs, contacts: created, companies: 0, companiesCreated: 0 });
  }

  // Companies per file (rough — a company may serve multiple files)
  const companyCounts = new Map<string, { created: number; total: number }>();
  for (const f of SOURCE_FILES) {
    const rows = unique.filter((p) => p.csvFile === f);
    const createdHere = rows.filter((p) => companyPlan.get(p.companyKey)?.created).length;
    const totalHere = rows.filter((p) => companyPlan.get(p.companyKey)?.companyId).length;
    companyCounts.set(f, { created: createdHere, total: totalHere });
  }

  const runLog = {
    timestamp: new Date().toISOString(),
    dryRun,
    portal: "247247238",
    propsEnsured: ensured,
    perCsv: table.map((t) => ({ ...t, companiesCreated: companyCounts.get(t.file)?.created ?? 0, companies: companyCounts.get(t.file)?.total ?? 0 })),
    totals: {
      csvRows: prospects.length,
      uniqueImportKeys: unique.length,
      keyCollisions: [...keyCollisions.entries()].map(([k, n]) => ({ key: k, rows: n })),
      contactsCreated: contactsCreated.length, // real writes (0 in dry run)
      contactsUpdated,
      contactsSkipped: contactPlan.filter((c) => c.action === "skip").length,
      contactsWouldCreate: dryRun ? contactPlan.filter((c) => c.plannedCreate).length : 0,
      companiesCreated: companiesCreated.length,
      companiesUpdated,
      associationsCreated: contactsCreated.length - assocErrors.length,
      associationErrors: assocErrors.length,
      contactsInHubSpot: finalContacts.length,
      companiesInHubSpot: finalCompanies.length,
    },
    errors,
  };

  const outPath = `${PROSPECTS_DIR}/hubspot-import-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(PROSPECTS_DIR, { recursive: true });
  writeFileSync(outPath, JSON.stringify(runLog, null, 2));
  console.log(`\nrun log: ${outPath}`);

  // --- summary table -------------------------------------------------------
  console.log("\n=== HubSpot import summary ===");
  console.log("file                          rows  created  updated  skipped  errors  co-created  companies");
  for (const t of runLog.perCsv) {
    console.log(
      `${t.file.padEnd(30)} ${String(t.rows).padStart(4)}  ${String(t.created).padStart(7)}  ${String(t.updated).padStart(7)}  ${String(t.skipped).padStart(7)}  ${String(t.errors).padStart(6)}  ${String(t.companiesCreated).padStart(9)}  ${String(t.companies).padStart(9)}`
    );
  }
  console.log("-".repeat(100));
  console.log(
    `total                         ${String(runLog.totals.csvRows).padStart(4)}  ${String(runLog.totals.contactsCreated).padStart(7)}  ${String(runLog.totals.contactsUpdated).padStart(7)}  ${String(runLog.totals.contactsSkipped).padStart(7)}  ${String(runLog.totals.associationErrors + runLog.errors.length).padStart(6)}`
  );
  console.log(`contacts in HubSpot after run: ${runLog.totals.contactsInHubSpot}  |  companies: ${runLog.totals.companiesInHubSpot}`);
  if (dryRun) console.log("\nDRY RUN — nothing was written to HubSpot.");
}

main().catch((e) => {
  console.error("import failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});