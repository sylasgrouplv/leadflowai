/**
 * HubSpot Region 1 (Detroit HVAC) association completion pass.
 *
 * Follow-up to the 2026-09-09T22:26 R1 import. That import's batch-create
 * responses came back async-empty ("no result"), so the in-import association
 * loop saw no contact ids and created 0 associations. The 195 R1 contacts and
 * their (deduped) companies now exist in the portal; this pass joins every
 * R1 CONTACT (lf_source_file = michigan-hvac-region1-detroit.csv, keyed by
 * the `lf_import_key` custom property) to its company using the SAME key the
 * import used, and creates any missing contact→company association.
 *
 * Join (mirrors hubspot-import.ts / the Sep-3 hubspot-associate.ts exactly):
 *   - email-key (contains "@") → business name/domain from the R1 CSV row.
 *   - name-key ("name|city|state") → CSV row by full normalized key.
 *   - Company lookup: DOMAIN first (companiesByDomain), else normalized NAME
 *     with city/state disambiguation. After the dedupe pass each R1
 *     name|city|state resolves to exactly ONE company (the surviving,
 *     lowest-id twin); the one domain-matched row resolves by domain.
 *   - No company match → SKIP (reported; nothing fabricated).
 *
 * Idempotent: reads existing contact→company associations first; only PUTs
 * absent pairs. No create/delete/update of contacts or companies.
 *
 * Run:
 *   cd /home/agent-lead/leadflowai/leadflow-ai-site
 *   bun run hubspot-associate-r1.ts [--dry-run]
 * Reads HUBSPOT_API_KEY (fallback platform Hubspot_API_key). Run summary →
 * /home/team/shared/prospects/hubspot-associate-run-<timestamp>.json
 */
import { HubSpotClient } from "./src/server/integrations/hubspot";
import type { HubSpotObject } from "./src/server/integrations/hubspot";
import { writeFileSync, mkdirSync } from "node:fs";

if (!process.env.HUBSPOT_API_KEY && process.env.Hubspot_API_key) {
  process.env.HUBSPOT_API_KEY = process.env.Hubspot_API_key;
}

const PROSPECTS_DIR = "/home/team/shared/prospects";
const SOURCE_FILES = ["michigan-hvac-region1-detroit.csv"] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (v: unknown): string => (v ?? "").toString().trim();
const normNameKey = (s: string): string => norm(s).toLowerCase().replace(/\s+/g, " ");

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
  name: string;
  city: string;
  state: string;
  domain: string;
  email: string;
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

const csvByEmail = new Map<string, CsvRow>();
const csvByNameKey = new Map<string, CsvRow>();
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
      const firstPipe = row.name.split("|")[0] ?? "";
      if (firstPipe && firstPipe !== row.name) {
        const shortNcs = `${firstPipe}|${cityState}`;
        if (!csvByNameCityState.has(shortNcs)) csvByNameCityState.set(shortNcs, row);
      }
    }
  }
}

/** All contacts carrying lf_import_key (then filtered to the R1 file below). */
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

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  if (!process.env.HUBSPOT_API_KEY) {
    console.error("No HubSpot API key: set HUBSPOT_API_KEY (or rely on Hubspot_API_key).");
    process.exit(2);
  }
  const client = new HubSpotClient();
  console.log(`HubSpot associate R1 (${dryRun ? "DRY RUN — no writes" : "LIVE RUN — writes enabled"})`);

  await loadCsvRows();
  console.log(`R1 CSV rows: ${csvByNameKey.size} name|city|state keys, ${csvByEmail.size} emails`);

  // --- Contacts: all keyed, then R1-scoped -----------------------------------
  const contactProps = ["email", "lf_import_key", "lf_source_file", "firstname", "lastname"] as const;
  const allKeyed = await searchAllContacts(client, contactProps);
  console.log(`contacts with lf_import_key: ${allKeyed.length}`);
  const r1Contacts = allKeyed.filter((c) => norm((c.properties ?? {}).lf_source_file) === SOURCE_FILES[0]);
  console.log(`R1 contacts (lf_source_file = ${SOURCE_FILES[0]}): ${r1Contacts.length}`);

  const contactsByKey = new Map<string, { id: string; email: string }[]>();
  for (const c of r1Contacts) {
    const ik = norm((c.properties ?? {}).lf_import_key);
    if (ik) {
      const arr = contactsByKey.get(ik) ?? [];
      arr.push({ id: c.id, email: norm((c.properties ?? {}).email) });
      contactsByKey.set(ik, arr);
    }
  }
  console.log(`distinct R1 import keys: ${contactsByKey.size} (across ${r1Contacts.length} contacts)`);

  // --- Companies + lookups -----------------------------------------------------
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

  // --- Plan per R1 contact -------------------------------------------------------
  const plans: { importKey: string; contactId: string; email: string; name: string; domain: string; companyId: string; companyName: string }[] = [];
  const skippedNoCompany: { importKey: string; name: string; domain: string }[] = [];

  for (const [importKey, contactList] of contactsByKey) {
    let name = "";
    let domain = "";
    let city = "";
    let state = "";
    let resolved = false;
    if (importKey.includes("@")) {
      const row = csvByEmail.get(importKey);
      if (row) {
        name = row.name;
        domain = row.domain;
        city = row.city;
        state = row.state;
        resolved = true;
      }
    } else {
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
      }
    }
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
    for (const contact of contactList) {
      plans.push({ importKey, contactId: contact.id, email: contact.email, name, domain, companyId, companyName });
    }
  }
  console.log(`planned: ${plans.length} associations  (skipped no-company: ${skippedNoCompany.length})`);

  // --- Existing associations (idempotency) --------------------------------------
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
    for (const e of errors) {
      if (!/no company is associated|NO_ASSOCIATIONS_FOUND/i.test(e.message)) {
        console.warn(`association-read warning for contact ${e.id}: ${e.message}`);
      }
    }
    await sleep(200);
  }
  console.log(`existing association pairs (from read): ${existingPairs.size}`);

  // --- Create missing associations ------------------------------------------------
  let newlyAssociated = 0;
  const errors: { importKey: string; contactId: string; message: string }[] = [];
  const conflicts: { importKey: string; contactId: string; planned: string; actual: string[] }[] = [];
  const createdThisRun: { importKey: string; contactId: string; companyId: string; companyName: string }[] = [];
  for (const p of plans) {
    const pair = `${p.contactId}|${p.companyId}`;
    if (existingPairs.has(pair)) continue;
    const actual = existingByContact.get(p.contactId) ?? [];
    if (actual.length > 0) {
      conflicts.push({ importKey: p.importKey, contactId: p.contactId, planned: p.companyId, actual });
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] would associate ${p.importKey} → ${p.companyId} (${p.companyName})`);
      existingPairs.add(pair);
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

  // --- Verify: read back associations for ALL R1 contacts --------------------------
  const allR1ContactIds = plans.map((p) => p.contactId);
  const uniqueR1ContactIds = [...new Set(allR1ContactIds)];
  const verified: { contactId: string; companyId: string }[] = [];
  const archivedCompanyIds = new Set<string>(); // associations pointing at deleted twins
  if (!dryRun && uniqueR1ContactIds.length > 0) {
    for (let i = 0; i < uniqueR1ContactIds.length; i += 100) {
      const chunk = uniqueR1ContactIds.slice(i, i + 100);
      const { byContact } = await client.readContactCompanyAssociations(chunk);
      for (const cid of chunk) {
        const coIds = byContact.get(cid) ?? [];
        if (coIds.length > 0) verified.push({ contactId: cid, companyId: coIds[0] });
        for (const co of coIds) {
          if (!companies.some((c) => c.id === co)) archivedCompanyIds.add(co);
        }
      }
      await sleep(200);
    }
  }
  console.log(`verify readback: ${verified.length}/${uniqueR1ContactIds.length} R1 contacts have a company association`);
  if (archivedCompanyIds.size > 0) console.log(`WARNING: associations pointing at non-listed (archived?) companies: ${[...archivedCompanyIds].join(", ")}`);

  // --- Summary + log -----------------------------------------------------------------
  const outPath = `${PROSPECTS_DIR}/hubspot-associate-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(PROSPECTS_DIR, { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        dryRun,
        portal: "247247238",
        sourceFile: SOURCE_FILES[0],
        totals: {
          contactsSeen: allKeyed.length,
          r1Contacts: r1Contacts.length,
          contactsWithKey: contactsByKey.size,
          planned: plans.length,
          newlyAssociated,
          attempted: newlyAssociated + errors.length,
          skippedNoCompany: skippedNoCompany.length,
          conflicts: conflicts.length,
          errors: errors.length,
          verifiedAssociated: verified.length,
          verifiedTotal: uniqueR1ContactIds.length,
          associationsPointingAtArchived: archivedCompanyIds.size,
        },
        skippedNoCompany: skippedNoCompany.slice(0, 100),
        createdThisRun,
        conflicts: conflicts.slice(0, 100),
        errors,
        verified,
      },
      null,
      2
    )
  );
  console.log(`run log: ${outPath}`);
}

main().catch((e) => {
  console.error("associate pass failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});