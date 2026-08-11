/**
 * Shared helpers for the team-ops activity-logging tools in this directory
 * (log.ts, daily-snapshot.ts).
 *
 * Ops tooling only — nothing here is imported by src/ or the deployed app.
 * No runtime dependencies beyond Bun's built-ins (fetch, Bun.file, Bun.write,
 * node:fs). Follows the team's mock/graceful-degradation pattern: when the
 * Supabase env vars are absent the callers fall back to a local directory
 * instead of crashing.
 */
import { mkdirSync } from "node:fs";

/** Default storage bucket. Override with SUPABASE_BUCKET. */
export const BUCKET = (Bun.env.SUPABASE_BUCKET || "activity-logs").trim();

/** Local fallback root (used when Supabase is not configured). */
export const LOCAL_ROOT = "/home/team/shared/activity-logs-local";

export interface OpsConfig {
  /** Supabase project URL, e.g. https://<project-ref>.supabase.co */
  url: string;
  /** service_role key (admin; can manage buckets/objects) */
  serviceKey: string;
  bucket: string;
}

/**
 * Read Supabase config from the environment. Returns null (plus the names of
 * the missing vars) when SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is absent
 * or empty — callers must then use the local fallback. Never throws.
 */
export function readConfig(): { config: OpsConfig | null; missing: string[] } {
  const url = (Bun.env.SUPABASE_URL || "").trim();
  const serviceKey = (Bun.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!serviceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) return { config: null, missing };
  return { config: { url, serviceKey, bucket: BUCKET }, missing: [] };
}

export function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Local-date "YYYY-MM-DD" (matches the bucket folder naming). */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-time "HHMMSS-mmm" (filename component). */
export function timeStamp(d: Date): string {
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

/** Lowercase, hyphenated, filesystem-safe slug (used in object names). */
export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "entry";
}

/** Schema for one activity entry (source: "team-ops"). */
export interface Entry {
  timestamp: string; // ISO 8601 UTC
  date: string; // YYYY-MM-DD (local)
  folder: string; // activity-logs/YYYY-MM-DD
  type: string;
  summary: string;
  detail: unknown;
  actor: string;
  source: "team-ops";
}

export function buildEntry(type: string, summary: string, detail: unknown, actor: string): Entry {
  const d = new Date();
  const date = formatDate(d);
  return {
    timestamp: d.toISOString(),
    date,
    folder: `activity-logs/${date}`,
    type,
    summary,
    detail,
    actor: actor.trim() || Bun.env.USER || "lead",
    source: "team-ops",
  };
}

/**
 * If the value looks like a JSON document ({...} or [...]), parse it; otherwise
 * keep the raw string. Lets callers pass --detail '{"k":"v"}' or plain text.
 */
export function parseMaybeJson(raw: string): unknown {
  const t = raw.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      /* not valid JSON — fall through to raw string */
    }
  }
  return raw;
}

// --- Supabase Storage API (service-role) -------------------------------------

/** Ensure the bucket exists. Idempotent: "already exists" responses are OK. */
export async function ensureBucket(cfg: OpsConfig): Promise<void> {
  const res = await fetch(`${cfg.url}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: cfg.bucket, public: false }),
  });
  if (res.ok) return; // created
  if (res.status === 409) return; // already exists (409 on some deployments)
  const text = await res.text().catch(() => "");
  if (res.status === 400 && /exist/i.test(text)) return; // "already exists" 400
  throw new Error(`create bucket "${cfg.bucket}" failed: HTTP ${res.status} ${text.slice(0, 200)}`);
}

/** Upload one object (one file per entry — never read-modify-write appends). */
export async function uploadObject(cfg: OpsConfig, path: string, content: string): Promise<void> {
  const res = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}/${path}?upsert=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.serviceKey}`,
      "Content-Type": "application/json",
      "x-upsert": "true",
    },
    body: content,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upload "${path}" failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

/** List object names under a prefix (folder), newest-last. */
export async function listObjects(cfg: OpsConfig, prefix: string): Promise<string[]> {
  const res = await fetch(`${cfg.url}/storage/v1/object/list/${cfg.bucket}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prefix,
      limit: 1000,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`list "${prefix}" failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => [])) as { name?: string }[];
  return (Array.isArray(data) ? data : []).map((o) => o.name || "").filter(Boolean);
}

/** Download an object's text content. */
export async function downloadObject(cfg: OpsConfig, path: string): Promise<string> {
  const res = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}/${path}`, {
    headers: { Authorization: `Bearer ${cfg.serviceKey}` },
  });
  if (!res.ok) throw new Error(`download "${path}" failed: HTTP ${res.status}`);
  return res.text();
}

/** Write a file, creating parent directories. */
export async function writeFileLocal(filePath: string, content: string): Promise<void> {
  const dir = filePath.slice(0, filePath.lastIndexOf("/"));
  if (dir) mkdirSync(dir, { recursive: true });
  await Bun.write(filePath, content);
}
