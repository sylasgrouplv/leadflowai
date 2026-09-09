/**
 * HubSpot prospect-import company-key helpers (company key-share fix).
 *
 * Background: the import keys each planned HubSpot company by the website
 * column's hostname (`domain:<host>`). Generic/shared platform hostnames —
 * `sites.google.com`, `facebook.com`, `linktr.ee`, `youtu.be`, `google.com`,
 * builder subdomains, etc. — are NOT unique to a business, so distinct
 * businesses collapsed onto one shared company record (e.g. Great Lakes
 * Gardening keyed onto East State Autocare via `sites.google.com`).
 *
 * Rule: a website hostname that is a shared platform host (exact match, or a
 * subdomain of one — `m.facebook.com`, `*.myshopify.com`,
 * `*.godaddysites.com`) is unusable as a company-dedupe key. Those rows fall
 * back to the per-business `name:<name>|<city>|<state>` key, so every
 * business still gets its own company. Real domains keep `domain:<host>`.
 *
 * Pure functions, no imports — safe to load from hermetic tests.
 */

/** Shared platform hosts. A website hostname equal to one of these, or a
 *  subdomain of one, can never identify a single business. Curated from the
 *  four market CSVs plus the obvious majors in each category. */
const SHARED_WEB_HOST_BASES: ReadonlySet<string> = new Set([
  // Search / big-tech hosts actually present in the CSV website column.
  "google.com",
  "sites.google.com",
  // Social / link-in-bio / video (facebook.com, linktr.ee, youtu.be present
  // in the CSVs; the rest are the same class of never-unique host).
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "linkedin.com",
  "linktr.ee",
  "youtube.com",
  "youtu.be",
  // Directories / marketplaces (angi.com present in the CSVs; a bare
  // directory homepage in the website column belongs to no business).
  "yelp.com",
  "thumbtack.com",
  "homeadvisor.com",
  "angi.com",
  "houzz.com",
  "bark.com",
  "porch.com",
  "nextdoor.com",
  // Site-builder / hosted-storefront platforms: each business lives on its
  // own subdomain, so the bare platform host — and any subdomain of it — is
  // shared (thsweeperxserviceallvac.myshopify.com and
  // thepaintingbizllc.godaddysites.com present in the CSVs).
  "myshopify.com",
  "godaddysites.com",
  "wixsite.com",
  "weebly.com",
  "wordpress.com",
  "blogspot.com",
  "squarespace.com",
  "webflow.io",
  "jimdosite.com",
  "strikingly.com",
  "dudaone.com",
  // Small agency host present in the CSVs (client sites on subdomains).
  "jany.io",
]);

/** True when a normalized website hostname is a shared platform host and
 *  must NOT be used as a company-dedupe key. Exact match or subdomain-of
 *  (dot-boundary, so `notfacebook.com` and `facebook.com.evil.com` are NOT
 *  flagged). Empty input is not "shared" — callers treat it as no domain. */
export function isSharedWebHost(domain: string): boolean {
  const d = (domain ?? "").trim().toLowerCase();
  if (!d) return false;
  if (SHARED_WEB_HOST_BASES.has(d)) return true;
  for (const base of SHARED_WEB_HOST_BASES) {
    if (d.endsWith(`.${base}`)) return true;
  }
  return false;
}

/** Company dedupe key for one prospect row: `domain:<host>` for a real,
 *  business-owned domain, otherwise the per-business `name:<nameKey>` where
 *  nameKey is the already-built `name|city|state` string. */
export function companyKeyFor(domain: string, nameKey: string): string {
  const d = (domain ?? "").trim().toLowerCase();
  if (d && !isSharedWebHost(d)) return `domain:${d}`;
  return `name:${nameKey}`;
}
