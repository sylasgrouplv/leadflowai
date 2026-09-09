/**
 * HubSpot Region 1 (Detroit HVAC) company double-create cleanup.
 *
 * The 2026-09-09T22:26 live import created the 195 R1 contacts once, but the
 * company batch create ran twice, leaving ~194 R1 business names with TWO
 * identical company records (created seconds apart; portal companies went
 * 663 → 1051). This pass:
 *
 *   1. Reads michigan-hvac-region1-detroit.csv for the exact business
 *      name + city + state set the import wrote.
 *   2. Pages through EVERY company, groups members by
 *      (normalized name | lowercase city | lowercase state).
 *   3. For each group that has ≥2 members created INSIDE the import window
 *      (2026-09-09 22:20:00Z – 22:40:00Z UTC), keeps the LOWEST company id
 *      and deletes (archives) the rest. Members created outside the window
 *      (pre-existing companies, e.g. the one name-matched row) are NEVER
 *      touched — this also leaves the Sep-3 pre-existing duplicates alone.
 *   4. Contacts are never listed or modified.
 *
 * SAFETY: no delete happens without --apply. The plan is fully printed first.
 * Run log → /home/team/shared/prospects/hubspot-dedupe-run-<timestamp>.json
 *
 * Run:
 *   cd /home/agent-lead/leadflowai/leadflow-ai-site
 *   bun run hubspot-dedupe-r1.ts          # analyze only (prints plan, writes log)
 *   bun run hubspot-dedupe-r1.ts --apply  # perform the deletes + verify
 */
import { writeFileSync, mkdirSync } from "node:fs";

if (!process.env.HUBSPOT_API_KEY && process.env.Hubspot_API_key) {
  process.env.HUBSPOT_API_KEY = process.env.Hubspot_API_key;
}

const PROSPECTS_DIR = "/home/team/shared/prospects";
const R1_CSV = `${PROSPECTS_DIR}/michigan-hvac-region1-detroit.csv`;

// Import run window (UTC) — the live import ran 2026-09-09T22:26Z.
const WINDOW_START = new Date("2026-09-09T22:20:00Z").getTime();
const WINDOW_END = new Date("2026-09-09T22:40:00Z").getTime();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (v: unknown): string => (v ?? "").toString().trim();
const normNameKey = (s: string): string => norm(s).toLowerCase().replace(/\s+/g, " ");

const COMPANIES_PROPS = "name,domain,phone,address,city,state,zip,website,lf_source_file";

interface CompanyRec {
  id: string;
  name: string;
  nameKey: string;
  city: string;
  state: string;
  domain: string;
  phone: string;
  createdAt: string; // ISO
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = process.env.HUBSPOT_API_KEY ?? "";
  if (!key) throw new Error("No HubSpot API key (HUBSPOT_API_KEY / Hubspot_API_key)");
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  const text = await res.text().catch(() => "");
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Page through all companies (archived excluded). */
async function listAllCompanies(): Promise<CompanyRec[]> {
  const out: CompanyRec[] = [];
  let after: string | undefined;
  for (let i = 0; ; i += 1) {
    const q = new URLSearchParams({ limit: "100", properties: COMPANIES_PROPS });
    if (after) q.set("after", after);
    const page = await api<{ results: any[]; paging?: { next?: { after?: string } } }>(
      "GET",
      `/crm/v3/objects/companies?${q.toString()}`
    );
    for (const c of page.results ?? []) {
      const props = c.properties ?? {};
      out.push({
        id: String(c.id),
        name: norm(props.name),
        nameKey: normNameKey(props.name),
        city: norm(props.city).toLowerCase(),
        state: norm(props.state).toLowerCase(),
        domain: norm(props.domain).toLowerCase().replace(/^www\./, ""),
        phone: norm(props.phone),
        createdAt: String(c.createdAt ?? ""),
      });
    }
    const next = page.paging?.next?.after;
    if (!next) break;
    after = next;
    if (i > 80) throw new Error("listAllCompanies: pagination runaway");
    await sleep(150);
  }
  return out;
}

async function readCsv(): Promise<{ nameKey: string; city: string; state: string; name: string }[]> {
  const scriptPath = "/tmp/lf_hubspot_csv_reader.py";
  writeFileSync(
    scriptPath,
    `import csv, json, sys
path = sys.argv[1]
with open(path, newline='', encoding='utf-8-sig') as f:
    rows = list(csv.DictReader(f))
print(json.dumps(rows))
`
  );
  const proc = Bun.spawnSync({ cmd: ["python3", scriptPath, R1_CSV], stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`csv parse failed: ${Buffer.from(proc.stderr ?? "").toString().slice(0, 300)}`);
  }
  const rows = JSON.parse(Buffer.from(proc.stdout ?? "").toString()) as Record<string, string>[];
  return rows.map((r) => ({
    nameKey: normNameKey(r.business_name),
    name: norm(r.business_name),
    city: norm(r.city).toLowerCase(),
    state: norm(r.state).toLowerCase(),
  }));
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.HUBSPOT_API_KEY) {
    console.error("No HubSpot API key: set HUBSPOT_API_KEY (or rely on Hubspot_API_key).");
    process.exit(2);
  }
  console.log(`HubSpot dedupe (${apply ? "APPLY — deletes enabled" : "ANALYZE ONLY — no writes"})`);

  // --- 1. R1 CSV reference set ---------------------------------------------
  const csvRows = await readCsv();
  console.log(`R1 CSV rows: ${csvRows.length}`);
  const r1ByNameCityState = new Map<string, { nameKey: string; name: string; city: string; state: string }>();
  for (const r of csvRows) {
    const k = `${r.nameKey}|${r.city}|${r.state}`;
    if (!r1ByNameCityState.has(k)) r1ByNameCityState.set(k, r);
  }
  console.log(`R1 unique name|city|state keys: ${r1ByNameCityState.size}`);

  // --- 2. Fetch every company -------------------------------------------------
  const companies = await listAllCompanies();
  console.log(`companies fetched: ${companies.length}`);

  // how many R1-name companies exist, and with what lf_source_file marker?
  const markerCounts = new Map<string, number>();
  for (const c of companies) {
    if (r1ByNameCityState.has(`${c.nameKey}|${c.city}|${c.state}`)) continue;
  }
  const r1Named = companies.filter((c) => {
    for (const k of r1ByNameCityState.keys()) if (c.nameKey === k.split("|")[0]) return true;
    return false;
  });
  console.log(`companies whose name matches an R1 row: ${r1Named.length}`);

  // --- 3. Group by R1 key, find twins created in the import window ------------
  const groups = new Map<string, CompanyRec[]>();
  for (const c of companies) {
    const k = `${c.nameKey}|${c.city}|${c.state}`;
    if (!r1ByNameCityState.has(k)) continue;
    const arr = groups.get(k) ?? [];
    arr.push(c);
    groups.set(k, arr);
  }
  console.log(`R1 name|city|state groups with ≥1 company: ${groups.size}`);

  const deletions: { key: string; keepId: string; deleteId: string; keepCreated: string; delCreated: string; members: string[] }[] = [];
  const windowCounts = new Map<number, number>(); // window-member count → number of groups
  for (const [key, members] of groups) {
    const inWindow = members
      .map((m) => ({ m, t: m.createdAt ? new Date(m.createdAt).getTime() : 0 }))
      .filter((x) => x.t >= WINDOW_START && x.t <= WINDOW_END);
    windowCounts.set(inWindow.length, (windowCounts.get(inWindow.length) ?? 0) + 1);
    if (inWindow.length < 2) continue;
    // Keep lowest id among in-window members; delete the rest.
    const sorted = [...inWindow].sort((a, b) => Number(a.m.id) - Number(b.m.id));
    const keep = sorted[0];
    for (const d of sorted.slice(1)) {
      deletions.push({
        key,
        keepId: keep.m.id,
        deleteId: d.m.id,
        keepCreated: keep.m.createdAt,
        delCreated: d.m.createdAt,
        members: members.map((m) => `${m.id}@${m.createdAt}`),
      });
    }
  }
  console.log(`group window-member distribution: ${JSON.stringify([...windowCounts.entries()].sort((a, b) => a[0] - b[0]))}`);
  console.log(`twin pairs: ${deletions.length}`);

  // --- 4. Plan summary ---------------------------------------------------------
  const preTotal = companies.length;
  const postTotal = preTotal - deletions.length;
  console.log("\n=== PLAN ===");
  console.log(`companies before: ${preTotal}  →  after: ${postTotal}  (delete ${deletions.length})`);
  console.log("first 8 deletions:");
  for (const d of deletions.slice(0, 8)) {
    console.log(`  ${d.key}: keep ${d.keepId} (${d.keepCreated})  delete ${d.deleteId} (${d.delCreated})`);
  }

  const outPath = `${PROSPECTS_DIR}/hubspot-dedupe-run-${new Date().toISOString().replace(/[:.]/g, "-")}${apply ? "" : "-ANALYZE"}.json`;
  mkdirSync(PROSPECTS_DIR, { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        applied: apply,
        portal: "247247238",
        window: { start: new Date(WINDOW_START).toISOString(), end: new Date(WINDOW_END).toISOString() },
        totals: { companiesBefore: preTotal, pairsFound: deletions.length, toDelete: deletions.length, companiesAfter: postTotal },
        deletions,
      },
      null,
      2
    )
  );
  console.log(`\nplan log: ${outPath}`);

  if (!apply) {
    console.log("\nANALYZE ONLY — re-run with --apply to delete.");
    return;
  }

  // --- 5. Apply (DELETE / archive the higher-id twin) --------------------------
  let deleted = 0;
  const errors: { id: string; message: string }[] = [];
  for (const d of deletions) {
    try {
      await api("DELETE", `/crm/v3/objects/companies/${d.deleteId}`);
      deleted += 1;
      await sleep(200);
    } catch (e) {
      errors.push({ id: d.deleteId, message: e instanceof Error ? e.message : String(e) });
      console.warn(`delete failed ${d.deleteId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`deleted: ${deleted}  (errors: ${errors.length})`);

  // --- 6. Verify: refetch, recompute groups, assert no twins remain ------------
  const after = await listAllCompanies();
  const afterGroups = new Map<string, CompanyRec[]>();
  for (const c of after) {
    const k = `${c.nameKey}|${c.city}|${c.state}`;
    if (!r1ByNameCityState.has(k)) continue;
    const arr = afterGroups.get(k) ?? [];
    arr.push(c);
    afterGroups.set(k, arr);
  }
  const windowAfter = new Map<number, number>();
  let dupSiblings = 0;
  for (const [, members] of afterGroups) {
    const inWindow = members.filter(
      (m) => (m.createdAt ? new Date(m.createdAt).getTime() : 0) >= WINDOW_START && (m.createdAt ? new Date(m.createdAt).getTime() : 0) <= WINDOW_END
    ).length;
    windowAfter.set(inWindow, (windowAfter.get(inWindow) ?? 0) + 1);
    if (inWindow > 1) dupSiblings += 1;
  }
  console.log(`\n=== VERIFY ===`);
  console.log(`companies after: ${after.length}  (expected ${postTotal})`);
  console.log(`R1 groups after, window-member distribution: ${JSON.stringify([...windowAfter.entries()].sort((a, b) => a[0] - b[0]))}`);
  console.log(`groups still holding >1 import-window company (duplicate siblings): ${dupSiblings}`);

  writeFileSync(
    outPath.replace(/\.json$/, "-VERIFY.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        portal: "247247238",
        companiesAfter: after.length,
        deleted,
        errors,
        dupSiblingGroups: dupSiblings,
        r1GroupsAfter: afterGroups.size,
        windowDistributionAfter: Object.fromEntries(windowAfter),
      },
      null,
      2
    )
  );
  console.log(`verify log: ${outPath.replace(/\.json$/, "-VERIFY.json")}`);
}

main().catch((e) => {
  console.error("dedupe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});