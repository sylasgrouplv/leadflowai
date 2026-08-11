/**
 * Session management — DB-backed sessions, random 256-bit tokens, SHA-256
 * token hashes stored server-side (a stolen DB dump is not a usable session),
 * delivered via HttpOnly cookies.
 */
import { createHash, randomBytes } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import * as repo from "../db/repo";
import { env, SITE_ROOT } from "../env";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export const SESSION_COOKIE = "lf_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable secret: env SESSION_SECRET, else a generated secret persisted in .data/. */
export function getSessionSecret(): string {
  if (env.sessionSecret) return env.sessionSecret;
  const dir = path.join(SITE_ROOT, ".data");
  const file = path.join(dir, ".session_secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dir, { recursive: true });
  const secret = randomBytes(48).toString("base64url");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await repo.insertSession(repo.newId(), userId, sha256(token), expiresAt);
  await repo.deleteExpiredSessions();
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  if (!token) return;
  const session = await repo.getSessionByTokenHash(sha256(token));
  if (session) await repo.deleteSession(session.id);
}

/** Returns the authenticated user for the request cookie, or null. */
export async function userFromRequest(c: Context): Promise<NonNullable<Awaited<ReturnType<typeof repo.getUserById>>> | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = await repo.getSessionByTokenHash(sha256(token));
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await repo.deleteSession(session.id);
    return null;
  }
  return repo.getUserById(session.userId);
}

export function setSessionCookie(c: Context, token: string, expiresAt: number) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.isHttpsRequest(c.req.header("x-forwarded-proto")),
    path: "/",
    maxAge: Math.floor((expiresAt - Date.now()) / 1000),
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
