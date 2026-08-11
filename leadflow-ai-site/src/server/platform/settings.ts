/**
 * PLATFORM SETTINGS — AI BRAIN 5b (spec §39 admin AI control).
 *
 * Typed access to the global agent switches + global defaults stored in the
 * platform_settings table. ONLY platform admins can write these (admin-only
 * /api/admin/ai routes) — business owners can never modify global safety rules.
 *
 * The switches are honored by the engine at the single choke points:
 *   - receptionist -> src/server/ai/engine.ts (AI welcome / auto-respond gate)
 *   - qualification -> score_lead tool handler (tools/registry.ts)
 *   - appointment  -> book_appointment tool handler (tools/registry.ts)
 *   - followup     -> sendFollowUpRow (followups/engine.ts)
 *   - review       -> requestReview (reviews/agent.ts)
 *   - bi           -> weekly report job (bi/report.ts)
 *   - escalation   -> createHumanTaskRecord (tools/registry.ts); HIGH_RISK
 *                     permission-blocked tool attempts are ALWAYS escalated
 *                     (safety rule — force bypasses the switch).
 */
import * as repo from "../db/repo";
import { DEFAULT_AI_CONFIG, type AiConfig } from "../db/repo";

export type AgentKey = "receptionist" | "qualification" | "appointment" | "followup" | "review" | "bi" | "escalation";
export const AGENT_KEYS: AgentKey[] = ["receptionist", "qualification", "appointment", "followup", "review", "bi", "escalation"];

export type AgentSwitches = Record<AgentKey, boolean>;

export const DEFAULT_AGENT_SWITCHES: AgentSwitches = {
  receptionist: true,
  qualification: true,
  appointment: true,
  followup: true,
  review: true,
  bi: true,
  escalation: true,
};

export interface GlobalDefaults {
  tone: AiConfig["tone"];
  responseLength: AiConfig["responseLength"];
  escalationSensitivity: AiConfig["escalationSensitivity"];
}

export const DEFAULT_GLOBAL_DEFAULTS: GlobalDefaults = {
  tone: DEFAULT_AI_CONFIG.tone,
  responseLength: DEFAULT_AI_CONFIG.responseLength,
  escalationSensitivity: DEFAULT_AI_CONFIG.escalationSensitivity,
};

function normalizeSwitches(v: unknown): AgentSwitches {
  const raw = (v ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_AGENT_SWITCHES };
  for (const key of AGENT_KEYS) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  return out;
}

function normalizeDefaults(v: unknown): GlobalDefaults {
  const raw = (v ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_GLOBAL_DEFAULTS };
  if (repo.AI_TONES.includes(raw.tone as never)) out.tone = raw.tone as GlobalDefaults["tone"];
  if (repo.AI_RESPONSE_LENGTHS.includes(raw.responseLength as never)) out.responseLength = raw.responseLength as GlobalDefaults["responseLength"];
  if (repo.ESCALATION_SENSITIVITIES.includes(raw.escalationSensitivity as never)) {
    out.escalationSensitivity = raw.escalationSensitivity as GlobalDefaults["escalationSensitivity"];
  }
  return out;
}

/** Current global agent switches (defaults: all enabled). */
export async function getAgentSwitches(): Promise<AgentSwitches> {
  const stored = await repo.getPlatformSetting("agents");
  return normalizeSwitches(stored);
}

/** Whether a global agent is currently enabled. */
export async function isAgentEnabled(agent: AgentKey): Promise<boolean> {
  const switches = await getAgentSwitches();
  return switches[agent];
}

/** Current global defaults (tone / response length / escalation sensitivity). */
export async function getGlobalDefaults(): Promise<GlobalDefaults> {
  const stored = await repo.getPlatformSetting("defaults");
  return normalizeDefaults(stored);
}

/** Admin write: replace the agent switches (validated shape). */
export async function setAgentSwitches(patch: Partial<AgentSwitches>): Promise<AgentSwitches> {
  const current = await getAgentSwitches();
  const next: AgentSwitches = { ...current };
  for (const key of AGENT_KEYS) {
    if (typeof patch[key] === "boolean") next[key] = patch[key] as boolean;
  }
  await repo.setPlatformSetting("agents", next);
  return next;
}

/** Admin write: replace the global defaults (validated shape). */
export async function setGlobalDefaults(patch: Partial<GlobalDefaults>): Promise<GlobalDefaults> {
  const current = await getGlobalDefaults();
  const next: GlobalDefaults = {
    tone: repo.AI_TONES.includes(patch.tone as never) ? (patch.tone as GlobalDefaults["tone"]) : current.tone,
    responseLength: repo.AI_RESPONSE_LENGTHS.includes(patch.responseLength as never)
      ? (patch.responseLength as GlobalDefaults["responseLength"])
      : current.responseLength,
    escalationSensitivity: repo.ESCALATION_SENSITIVITIES.includes(patch.escalationSensitivity as never)
      ? (patch.escalationSensitivity as GlobalDefaults["escalationSensitivity"])
      : current.escalationSensitivity,
  };
  await repo.setPlatformSetting("defaults", next);
  return next;
}
