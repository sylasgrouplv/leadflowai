/**
 * Vercel deploy (REST API) — the team's VERCEL_TOKEN is a limited token that
 * the Vercel CLI cannot authenticate with ("Not able to load teams"), so this
 * drives the whole deploy through the REST API:
 *
 *   1. build the SPA (vite -> dist/client)
 *   2. assemble a deploy bundle (src/ + api/ + public/ + configs; the built
 *      SPA + widget.js land in public/ so Vercel serves them statically)
 *   3. create the project if it doesn't exist
 *   4. upsert env vars (DATABASE_URL, SESSION_SECRET, INTERNAL_TOKEN)
 *   5. create a production deployment (inline base64 file upload)
 *   6. poll until READY, drop SSO protection, print the live URL
 *
 * Run: VERCEL_TOKEN=... DATABASE_URL=... bun run scripts/deploy-vercel.ts
 * (go-live.sh wraps this). Never prints or commits secrets.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, cpSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname); // site root
const PROJECT = "leadflow-ai";
const TOKEN = process.env.VERCEL_TOKEN || "";
const TEAM_ID = process.env.VERCEL_TEAM_ID || "";

const api = async (method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const res = await fetch(`https://api.vercel.com${url}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const teamQ = () => (TEAM_ID ? `?teamId=${TEAM_ID}` : "");

function collectFiles(dir: string, prefix: string): { file: string; data: string }[] {
  const out: { file: string; data: string }[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...collectFiles(abs, rel));
    else if (statSync(abs).size > 0) out.push({ file: rel, data: readFileSync(abs, "utf8") });
    else out.push({ file: rel, data: "" });
  }
  return out;
}

async function main() {
  if (!TOKEN) throw new Error("VERCEL_TOKEN is required");
  const user = await api("GET", "/v2/user");
  const teamId = TEAM_ID || user.json?.user?.defaultTeamId || "";
  if (!teamId) throw new Error("could not resolve team id (set VERCEL_TEAM_ID)");
  process.env.VERCEL_TEAM_ID = teamId;

  console.log(`[1/6] building SPA (vite -> dist/client)`);
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) throw new Error("vite build failed");

  console.log(`[2/6] assembling deploy bundle`);
  const bundle = `/tmp/lf-vercel-deploy-${Date.now()}`;
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(bundle, { recursive: true });
  for (const item of ["package.json", "bun.lock", "tsconfig.json", "vite.config.ts", "vercel.json", "api", "src", "public"]) {
    cpSync(path.join(ROOT, item), path.join(bundle, item), { recursive: true });
  }
  // Built SPA + widget.js become the static site (public/ is served by Vercel).
  const distClient = path.join(ROOT, "dist", "client");
  if (!existsSync(distClient)) throw new Error("dist/client missing after build");
  for (const name of readdirSync(distClient)) {
    cpSync(path.join(distClient, name), path.join(bundle, "public", name), { recursive: true });
  }
  const files = collectFiles(bundle, "");

  console.log(`[3/6] ensuring project "${PROJECT}" exists`);
  let proj = await api("GET", `/v9/projects/${PROJECT}${teamQ()}`);
  if (proj.status === 404) {
    proj = await api("POST", `/v10/projects${teamQ()}`, { name: PROJECT, framework: null });
    if (proj.status !== 200) {
      throw new Error(
        `cannot create project "${PROJECT}" (HTTP ${proj.status}: ${proj.json?.error?.message || JSON.stringify(proj.json)}). ` +
          `The VERCEL_TOKEN is limited: it may not have project-create permission. ` +
          `Create the project manually in the Vercel dashboard (team ${teamId}) or re-collect a token with create+deploy scopes, then re-run.`
      );
    }
    console.log(`   created project ${PROJECT}`);
  }

  console.log(`[4/6] upserting env vars`);
  const envs: Record<string, string> = {};
  for (const key of ["DATABASE_URL", "SESSION_SECRET", "INTERNAL_TOKEN"] as const) {
    if (process.env[key]) {
      envs[key] = process.env[key]!;
    } else {
      const existing = await api("GET", `/v8/projects/${PROJECT}/env/${key}${teamQ()}`);
      envs[key] = existing.status === 200 ? (existing.json?.value ?? "") : "";
    }
  }
  const gen = () => Bun.randomUUIDv7().replaceAll("-", "") + Bun.randomUUIDv7().replaceAll("-", "");
  for (const key of ["DATABASE_URL", "SESSION_SECRET", "INTERNAL_TOKEN"] as const) {
    let value = envs[key] || (key === "DATABASE_URL" ? "" : gen());
    if (key === "DATABASE_URL" && !value) {
      throw new Error("DATABASE_URL is required (set it in the environment; the Neon pooled URL)");
    }
    const res = await api("POST", `/v10/projects/${PROJECT}/env${teamQ()}${TEAM_ID ? "&upsert=true" : "?upsert=true"}`, {
      key, value, type: "encrypted", target: ["production", "preview", "development"],
    });
    if (res.status !== 200 && res.status !== 201) throw new Error(`could not set ${key} (HTTP ${res.status}: ${res.json?.error?.message})`);
    console.log(`   ${key} ${value ? "set" : "unchanged"}`);
  }

  console.log(`[5/6] creating production deployment (${files.length} files)`);
  const dep = await api("POST", `/v13/deployments${teamQ()}`, {
    name: PROJECT, project: PROJECT, files, target: "production",
  });
  if (dep.status !== 200) {
    throw new Error(`deployment failed (HTTP ${dep.status}: ${JSON.stringify(dep.json).slice(0, 300)})`);
  }
  const depId = dep.json.id;
  const depUrl = dep.json.url ? `https://${dep.json.url}` : "";
  console.log(`   deployment ${depId} ${depUrl}`);

  console.log(`[6/6] polling deployment status`);
  let state = "";
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(5000);
    const d = await api("GET", `/v13/deployments/${depId}${teamQ()}`);
    state = d.json.readyState || d.json.status || "?";
    console.log(`   ${state}`);
    if (state === "READY" || state === "ERROR" || state === "CANCELED") break;
  }
  if (state !== "READY") throw new Error(`deployment ended in state ${state} — check the Vercel dashboard`);

  await api("PATCH", `/v9/projects/${PROJECT}${teamQ()}`, { ssoProtection: null });
  const dom = await api("GET", `/v9/projects/${PROJECT}/domains${teamQ()}`);
  const domain = (dom.json?.domains || []).map((x: any) => x.name).find((n: string) => n.endsWith(".vercel.app"));
  const live = domain ? `https://${domain}` : depUrl;
  console.log(`LIVE: ${live}`);
  console.log(`Cron: /api/internal/tick scheduled via vercel.json crons (*/5 * * * *); Vercel enforces its plan minimum.`);
}

main().catch((e) => {
  console.error(`deploy failed: ${e.message}`);
  process.exit(1);
});
