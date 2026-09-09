/**
 * HubSpot prospect-import company key-share fix — hermetic tests.
 *
 * Regression coverage for the shared-host company-dedupe bug (Great Lakes
 * Gardening keyed onto East State Autocare via `sites.google.com`):
 *   - real domains still produce `domain:<host>` keys,
 *   - blocklisted hosts (sites.google.com, facebook.com, linktr.ee,
 *     youtu.be, google.com, …) fall back to the per-business
 *     `name:<name>|<city>|<state>` key,
 *   - two different businesses sharing facebook.com get DIFFERENT keys,
 *   - subdomain variants (m.facebook.com, *.myshopify.com,
 *     *.godaddysites.com) are caught; lookalikes (notfacebook.com) are not.
 *
 * Pure key helpers only — no network, no DB, no keys, no CSV reads.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && bun run hubspot-import-key-test.ts
 */
import { isSharedWebHost, companyKeyFor } from "./src/server/crm/hubspot-import-keys";

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

// 1. Real domains keep the domain key.
assertEq(
  "real domain keeps domain key",
  companyKeyFor("acmeplumbing.com", "acme plumbing|fort wayne|in"),
  "domain:acmeplumbing.com"
);
assertEq(
  "real multi-label domain keeps domain key",
  companyKeyFor("rotorooter.com", "roto-rooter|fort wayne|in"),
  "domain:rotorooter.com"
);
// Same-business name-variant rows on a REAL shared domain still merge (the
// fix only affects blocklisted hosts: e.g. two Hoosier Maids rows).
assertEq(
  "same real domain, two name variants → same domain key",
  companyKeyFor("hoosiermaids.com", "hoosier maids - cleaning services|fort wayne|in") ===
    companyKeyFor("hoosiermaids.com", "hoosier maids - house cleaning services|fort wayne|in"),
  true
);

// 2. sites.google.com falls back to the name-based key (the reported bug).
assertEq(
  "sites.google.com is shared",
  isSharedWebHost("sites.google.com"),
  true
);
assertEq(
  "great lakes gardening gets a name key, not the shared domain key",
  companyKeyFor("sites.google.com", "great lakes gardening and hardscapes|ann arbor|mi"),
  "name:great lakes gardening and hardscapes|ann arbor|mi"
);
assertEq(
  "east state autocare also gets its OWN name key (no merge)",
  companyKeyFor("sites.google.com", "east state autocare|fort wayne|in"),
  "name:east state autocare|fort wayne|in"
);

// 3. Two different businesses sharing facebook.com get DIFFERENT keys.
{
  const a = companyKeyFor("facebook.com", "me2 automotive care|fort wayne|in");
  const b = companyKeyFor("facebook.com", "all lawn care service & landscaping llc|fort wayne|in");
  pass("facebook.com is shared", isSharedWebHost("facebook.com"));
  pass("two facebook.com businesses get different keys", a !== b, `${a} vs ${b}`);
  pass("facebook.com key is name-based", a.startsWith("name:") && b.startsWith("name:"));
}

// 4. Other blocklisted hosts from the CSVs + the same class.
for (const host of [
  "google.com",
  "linktr.ee",
  "youtu.be",
  "m.facebook.com",
  "angi.com",
  "thsweeperxserviceallvac.myshopify.com",
  "thepaintingbizllc.godaddysites.com",
  "bills-auto-repair-fort-wayne.jany.io",
]) {
  pass(`${host} is shared`, isSharedWebHost(host));
}
assertEq(
  "google.com falls back to name key",
  companyKeyFor("google.com", "g townsend|fort wayne|in"),
  "name:g townsend|fort wayne|in"
);
assertEq(
  "youtu.be falls back to name key",
  companyKeyFor("youtu.be", "manz|fort wayne|in"),
  "name:manz|fort wayne|in"
);
assertEq(
  "bare myshopify.com host is shared",
  isSharedWebHost("myshopify.com"),
  true
);

// 5. Lookalikes and real domains are NOT flagged.
for (const host of ["notfacebook.com", "facebook.com.evil.com", "acmeplumbing.com", "kortedoesitall.com"]) {
  pass(`${host} is not shared`, !isSharedWebHost(host));
}

// 6. Edge cases: empty domain → name key; case/whitespace tolerated.
assertEq(
  "empty domain → name key",
  companyKeyFor("", "acme|fort wayne|in"),
  "name:acme|fort wayne|in"
);
pass("uppercase FACEBOOK.COM is shared", isSharedWebHost("  FACEBOOK.COM  "));
assertEq(
  "uppercase real domain still domain-keys (normalized)",
  companyKeyFor("AcmePlumbing.COM", "acme|fort wayne|in"),
  "domain:acmeplumbing.com"
);

console.log(failures === 0 ? "\nALL HUBSPOT IMPORT KEY TESTS PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
