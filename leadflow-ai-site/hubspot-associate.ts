/**
 * HubSpot prospect backfill — contact→company association completion pass
 * (Phase 1 task 4 follow-up; scope doc §3.1 / §7).
 *
 * The one-time import (hubspot-import.ts, merged as #26) created 659 contacts
 * + 649 companies from the 4 market CSVs, but its batch-create responses came
 * back async-empty, so the association PUT loop saw no ids and created 0
 * associations. This pass joins every imported CONTACT (identified by the
 * `lf_import_key` custom property — "email" or "name|city|state" lowercased)
 * to its COMPANY using the SAME key the import used to create them, and
 * creates any contact→company association that is missing.
 *
 * Join (mirrors hubspot-import.ts exactly):
 *   - Driven by the ACTUAL stored `lf_import_key` on each imported contact
 *     (this also covers the import's collision re-key: a row re-keyed on
 *     name|city|state carries that name-key, resolved below).
 *   - name-key (`a|b|c`, no "@"): the business name is the part before the
 *     first "|"; city/state are the trailing parts. Domain comes from the CSV
 *     row with the same normalized name + city/state.
 *   - email-key (contains "@"): business name + domain come from the CSV row
 *     with that email.
 *   - Company lookup: DOMAIN first (companiesByDomain — same preference as the
 *     import), else normalized NAME with city/state disambiguation for
 *     same-named companies (same rule as the import).
 *   - No company match → SKIP (reported; nothing fabricated).
 *
 * Idempotency: before creating anything the pass batch-reads existing
 * contact→company associations (in ≤100 chunks) and only PUTs pairs that are
 * absent. HubSpot association PUTs are idempotent for the same pair, but the
 * check keeps each run's "new" count honest (a re-run reports 0 new).
 *
 * Surgical: no create/delete/update of contacts or companies, no email, no
 * sales motion — data-integrity completion only.
 *
 * Run:
 *   cd /home/agent-lead/leadflowai/leadflow-ai-site
 *   bun run hubspot-associate.ts [--limit N] [--dry-run]
 *
 * Reads the API key from HUBSPOT_API_KEY, falling back to the platform's
 * injected `Hubspot_API_key`. A run summary is written to
 * /home/team/shared/prospects/hubspot-associate-run-<timestamp>.json
 *
 * HubSpot rate limits: ~100 req / 10 s per account. The pass is paced: 100ms
 * between single PUTs (~83/10s) and a short settle between batch reads.
 */
import { HubSpotClient } from "./src/server/integrations/hubspot";
import type { HubSpotObject } from "./src/server/integrations/hubspot";
import { writeFileSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Env / config
// ---------------------------------------------------------------------------

if (!process.env.HUBSPOT_API_KEY && process.env.Hubspot_API_key) {
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

const norm = (v: unknown): string => (v ?? "").toString().trim();
/** EXACT same normalization hubspot-import.ts uses for business names. */
const normNameKey = (s: string): string => norm(s).toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// CSV reading (same python3 helper as the import)
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

interface CsvRow {
  name: string; // normNameKey(business_name)
  city: string; // lowercase
  state: string; // lowercase
  domain: string; // hostname w/o www, lowercase ("" when none)
  email: string; // lowercase ("" when none)
}

function csvRow(r: Record<string, string>): CsvRow {
  const city = norm(r.city).toLowerCase();
  const state = norm(r.state).toLowerCase();
  let domain = "";
  const w = norm(r.website ?? "");
  if (w) {
    const url = /^https?:\/\//i.test(w) ? w : `https://${w}`;
    try {
      const host = new URL(url).hostname.toLowerCase();
      domain = host.startsWith("www.") ? host.slice(4) : host;
    } catch {
      domain = "";
    }
  }
  return { name: normNameKey(r.business_name), city, state, domain, email: norm(r.email ?? "").toLowerCase() };
}

// CSV lookups
const csvByEmail = new Map<string, CsvRow>();
/** keyed by the FULL normalized import name-key (name|city|state with the
 *  business name as stored — handles "|" inside names) */
const csvByNameKey = new Map<string, CsvRow>();
/** keyed by the split-reconstructed name|city|state (first-| split) */
const csvByNameCityState = new Map<string, CsvRow>();

async function loadCsvRows(): Promise<void> {
  for (const f of SOURCE_FILES) {
    const rows = await readCsv(`${PROSPECTS_DIR}/${f}`);
    for (const r of rows) {
      const row = csvRow(r);
      if (row.email) csvByEmail.set(row.email, row);
      const cityState = row.city ? `${row.city}|${row.state}` : row.state;
      const ncs = `${row.name}|${cityState}`;
      if (!csvByNameKey.has(ncs)) csvByNameKey.set(ncs, row);
      // Also key by name + city/state separately for the fallback split path.
      const firstPipe = row.name.split("|")[0] ?? "";
      if (firstPipe && firstPipe !== row.name) {
        const shortNcs = `${firstPipe}|${cityState}`;
        if (!csvByNameCityState.has(shortNcs)) csvByNameCityState.set(shortNcs, row);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HubSpot paging helpers
// ---------------------------------------------------------------------------

/** Page through ALL contacts/companies matching the given search body. */
async function searchAllContacts(client: HubSpotClient, properties: readonly string[]): Promise<HubSpotObject[]> {
  const out: HubSpotObject[] = [];
  let after = 0;
  for (let i = 0; ; i += 1) {
    const res = await client.searchContacts({
      filterGroups: [{ filters: [{ propertyName: "lf_import_key", operator: "HAS_PROPERTY" }] }],
      properties,
      limit: 100,
      after,
    });
    out.push(...(res.results as HubSpotObject[]));
    const next = res.paging?.next?.after;
    if (!next) break;
    after = Number(next);
    if (i > 50) throw new Error("searchAllContacts: pagination runaway");
    await sleep(150);
  }
  return out;
}

async function listAllCompanies(client: HubSpotClient): Promise<HubSpotObject[]> {
  const out: HubSpotObject[] = [];
  let after: string | undefined;
  for (let i = 0; ; i += 1) {
    const q = new URLSearchParams({ limit: "100", properties: "name,domain,city,state,phone,website" });
    if (after) q.set("after", after);
    const page = await client.listObjects<HubSpotObject>(`/crm/v3/objects/companies?${q.toString()}`);
    out.push(...(page.results as HubSpotObject[]));
    const next = page.paging?.next?.after;
    if (!next) break;
    after = next;
    if (i > 50) throw new Error("listAllCompanies: pagination runaway");
    await sleep(150);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

  if (!process.env.HUBSPOT_API_KEY) {
    console.error("No HubSpot API key: set HUBSPOT_API_KEY (or rely on the platform's Hubspot_API_key env var).");
    process.exit(2);
  }
  const client = new HubSpotClient();
  console.log(`HubSpot client ready (${dryRun ? "DRY RUN — no writes" : "LIVE RUN — writes enabled"})${Number.isFinite(limit) ? `, limit=${limit}` : ""}`);

  // --- 1. Load CSV rows for name/domain resolution -------------------------
  await loadCsvRows();
  console.log(`CSV rows loaded: ${csvByNameKey.size} unique name|city|state keys, ${csvByEmail.size} emails`);

  // --- 2. Fetch all imported contacts (lf_import_key HAS_PROPERTY) ---------
  const contactProps = ["email", "lf_import_key", "lf_source_file", "firstname", "lastname"] as const;
  const contacts = await searchAllContacts(client, contactProps);
  console.log(`imported contacts fetched: ${contacts.length}`);
  // Contact list per key — a key MAY map to several contacts (import collision
  // re-key wrote the same name|city|state key onto 2 contacts); associate ALL.
  const contactsByKey = new Map<string, { id: string; email: string }[]>();
  for (const c of contacts) {
    const ik = norm((c.properties ?? {}).lf_import_key);
    if (ik) {
      const arr = contactsByKey.get(ik) ?? [];
      arr.push({ id: c.id, email: norm((c.properties ?? {}).email) });
      contactsByKey.set(ik, arr);
    }
  }
  console.log(`distinct lf_import_key values: ${contactsByKey.size} (across ${contacts.length} contacts)`);

  // --- 3. Fetch all companies + build lookups --------------------------------
  const companies = await listAllCompanies(client);
  console.log(`companies fetched: ${companies.length}`);

  const companiesByDomain = new Map<string, { id: string }>();
  const companiesByName = new Map<string, { id: string; city: string; state: string }[]>();
  for (const c of companies) {
    const props = c.properties ?? {};
    const domain = norm(props.domain).toLowerCase().replace(/^www\./, "");
    if (domain) companiesByDomain.set(domain, { id: c.id });
    const name = normNameKey(norm(props.name));
    if (name) {
      const arr = companiesByName.get(name) ?? [];
      arr.push({ id: c.id, city: norm(props.city).toLowerCase(), state: norm(props.state).toLowerCase() });
      companiesByName.set(name, arr);
    }
  }
  console.log(`lookups: ${companiesByDomain.size} domains, ${companiesByName.size} names`);

  // --- 4. Plan per contact (exact import join) ------------------------------
  const plans: { importKey: string; contactId: string; email: string; name: string; domain: string; companyId: string; companyName: string }[] = [];
  const skippedNoCompany: { importKey: string; name: string; domain: string }[] = [];

  for (const [importKey, contactList] of contactsByKey) {
    if (Number.isFinite(limit) && plans.length + skippedNoCompany.length >= limit) break;
    // Resolve expected company name + domain from the key itself + CSVs.
    let name = "";
    let domain = "";
    let city = "";
    let state = "";
    let resolved = false;
    if (importKey.includes("@")) {
      // email-key: name/domain from the CSV row with this email.
      const row = csvByEmail.get(importKey);
      if (row) {
        name = row.name;
        domain = row.domain;
        city = row.city;
        state = row.state;
        resolved = true;
      }
    } else {
      // name-key: "<name>|<city>|<state>" (or "<name>|<state>" when no city).
      // NOTE: business names may THEMSELVES contain "|" (CSV data quirk, e.g.
      // "Infinity Outdoor Services | Tree Services Fort Wayne"). The import
      // keys off the FULL normalized name, so first try the full key as-is.
      const row = csvByNameKey.get(importKey) ?? csvByNameCityState.get(importKey);
      if (row) {
        name = row.name;
        domain = row.domain;
        city = row.city;
        state = row.state;
        resolved = true;
      } else {
        const parts = importKey.split("|").map((s) => norm(s));
        name = parts[0] ?? "";
        if (parts.length >= 3) {
          city = parts[parts.length - 2];
          state = parts[parts.length - 1];
        } else if (parts.length === 2) {
          state = parts[1];
        }
        // domain from the CSV row with this exact name|city|state.
        const ncsKey = `${name}|${city ? `${city}|${state}` : state}`;
        const rowNcs = csvByNameKey.get(ncsKey);
        if (rowNcs) {
          domain = rowNcs.domain;
          resolved = true;
        }
      }
    }
    // Fallback: no CSV row (e.g. a name-key whose city/state are compacted) —
    // still resolve by name parts so the join does not silently drop contacts.
    if (!resolved && name) {
      const parts = importKey.split("|").map((s) => norm(s));
      name = parts[0] ?? "";
      if (parts.length >= 3) {
        city = parts[parts.length - 2];
        state = parts[parts.length - 1];
      }
    }
    if (!name) {
      skippedNoCompany.push({ importKey, name, domain });
      continue;
    }

    // --- company resolution (domain first, then name+city/state) ---
    let companyId = "";
    let companyName = "";
    if (domain) {
      const byDomain = companiesByDomain.get(domain);
      if (byDomain) companyId = byDomain.id;
    }
    if (!companyId) {
      const byName = companiesByName.get(name);
      if (byName && byName.length > 0) {
        const match =
          byName.find((c) => (city ? c.city === city : true) && (state ? c.state === state : true)) ?? byName[0];
        companyId = match.id;
      }
    }
    if (!companyId) {
      skippedNoCompany.push({ importKey, name, domain });
      continue;
    }
    const companyObj = companies.find((c) => c.id === companyId);
    companyName = companyObj ? norm(companyObj.properties?.name) : name;
    // Associate EVERY contact that carries this key (duplicate-key contacts).
    for (const contact of contactList) {
      plans.push({ importKey, contactId: contact.id, email: contact.email, name, domain, companyId, companyName });
    }
  }
  console.log(`planned: ${plans.length} associations  (skipped no-company: ${skippedNoCompany.length})`);

  // --- 5. Read existing associations (idempotency) --------------------------
  const existingPairs = new Set<string>();
  const existingByContact = new Map<string, string[]>();
  for (let i = 0; i < plans.length; i += 100) {
    const chunk = plans.slice(i, i + 100).map((p) => p.contactId);
    const { byContact, errors } = await client.readContactCompanyAssociations(chunk);
    for (const [cid, companyIds] of byContact) {
      for (const co of companyIds) existingPairs.add(`${cid}|${co}`);
      const prev = existingByContact.get(cid) ?? [];
      prev.push(...companyIds);
      existingByContact.set(cid, prev);
    }
    // errors where the message says the contact has no company association are
    // the NORMAL representation of "no association" in batch/read — silent.
    // Anything else is worth surfacing.
    for (const e of errors) {
      if (!/no company is associated|NO_ASSOCIATIONS_FOUND/i.test(e.message)) {
        console.warn(`association-read warning for contact ${e.id}: ${e.message}`);
      }
    }
    await sleep(200);
  }
  console.log(`existing association pairs (from read): ${existingPairs.size}`);

  // --- 6. Create missing associations (paced) -------------------------------
  let newlyAssociated = 0;
  const errors: { importKey: string; contactId: string; message: string }[] = [];
  const conflicts: { importKey: string; contactId: string; planned: string; actual: string[] }[] = [];
  const createdThisRun: { importKey: string; contactId: string; companyId: string; companyName: string }[] = [];
  for (const p of plans) {
    const pair = `${p.contactId}|${p.companyId}`;
    if (existingPairs.has(pair)) continue;
    const actual = existingByContact.get(p.contactId) ?? [];
    if (actual.length > 0) {
      // Contact already belongs to a company but not my planned one. Do NOT add
      // a second association (a contact belongs-to ONE company); report only.
      conflicts.push({ importKey: p.importKey, contactId: p.contactId, planned: p.companyId, actual });
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] would associate ${p.importKey} → ${p.companyId} (${p.companyName})`);
      existingPairs.add(pair); // don't double-report in dry-run
      newlyAssociated += 1;
      continue;
    }
    try {
      await client.associateContactToCompany(p.contactId, p.companyId);
      existingPairs.add(pair);
      existingByContact.set(p.contactId, [p.companyId]);
      newlyAssociated += 1;
      createdThisRun.push({ importKey: p.importKey, contactId: p.contactId, companyId: p.companyId, companyName: p.companyName });
      await sleep(100);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ importKey: p.importKey, contactId: p.contactId, message: msg });
      console.warn(`associate failed [${p.importKey}] (${p.contactId} → ${p.companyId}): ${msg}`);
    }
  }
  console.log(`newly associated: ${newlyAssociated}  (errors: ${errors.length})`);

  // --- 7. Verify: re-read sample of (newly) associated contacts --------------
  const sampleVerified: { contactId: string; companyId: string; companyName: string }[] = [];
  if (!dryRun && new Set(plans.map((p) => `${p.contactId}|${p.companyId}`)).size > 0) {
    const sample = plans
      .filter((p) => existingPairs.has(`${p.contactId}|${p.companyId}`))
      .slice(0, 8)
      .map((p) => ({ p, want: p.companyId }));
    const ids = sample.map((s) => s.p.contactId);
    const { byContact } = await client.readContactCompanyAssociations(ids);
    for (const s of sample) {
      const coIds = byContact.get(s.p.contactId) ?? [];
      const ok = coIds.includes(s.want);
      sampleVerified.push({
        contactId: s.p.contactId,
        companyId: coIds[0] ?? "",
        companyName: ok ? s.p.companyName : "(MISMATCH)",
      });
    }
  }

  // --- 8. Summary + log -------------------------------------------------------
  const outPath = `${PROSPECTS_DIR}/hubspot-associate-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(PROSPECTS_DIR, { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        dryRun,
        portal: "247247238",
        totals: {
          contactsSeen: contacts.length,
          contactsWithKey: contactsByKey.size,
          planned: plans.length,
          alreadyAssociated: existingPairs.size - newlyAssociated - (dryRun ? newlyAssociated : 0),
          newlyAssociated,
          attempted: newlyAssociated + errors.length,
          skippedNoCompany: skippedNoCompany.length,
          conflicts: conflicts.length,
          errors: errors.length,
          verifiedSample: sampleVerified.length,
        },
        skippedNoCompany: skippedNoCompany.slice(0, 100),
        createdThisRun,
        conflicts: conflicts.slice(0, 100),
        errors,
        sampleVerified,
      },
      null,
      2
    )
  );
  console.log(`run log: ${outPath}`);

  console.log("\n=== HubSpot association completion summary ===");
  console.log(`contacts fetched (lf_import_key set): ${contacts.length}`);
  console.log(`distinct lf_import_key values:         ${contactsByKey.size}`);
  console.log(`planned associations:                  ${plans.length}`);
  console.log(`newly associated this run:             ${newlyAssociated}`);
  console.log(`skipped (no company match):            ${skippedNoCompany.length}`);
  if (skippedNoCompany.length > 0) {
    console.log("  example keys (first 8):");
    for (const k of skippedNoCompany.slice(0, 8)) console.log(`    - ${k.importKey}  (name="${k.name}", domain="${k.domain}")`);
  }
  console.log(`errors:                                ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log(`    - [${e.importKey}] (${e.contactId}): ${e.message}`);
  console.log(`conflicts (already belongs to another company): ${conflicts.length}`);
  for (const c of conflicts.slice(0, 8)) console.log(`    - [${c.importKey}] (${c.contactId}) planned ${c.planned} actual ${JSON.stringify(c.actual)}`);
  if (sampleVerified.length > 0) {
    console.log(`verified sample (${sampleVerified.length}):`);
    for (const s of sampleVerified) console.log(`    - ${s.contactId} → ${s.companyId} ${s.companyName}`);
  }
  if (dryRun) console.log("\nDRY RUN — no writes performed.");
}

main().catch((e) => {
  console.error("associate pass failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});