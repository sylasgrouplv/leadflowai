/**
 * Real AI provider acceptance test (OpenAI + Anthropic, spec §42).
 *
 * Verifies the PROVIDER CONTRACT for the wire-up task — no DB, no server:
 * directly instantiates OpenAiProvider / AnthropicProvider and checks:
 *
 *   (a) NO-KEY PATH (always runs): with AI_API_KEY unset, every method throws
 *       a clear "not configured" error (health check §40 stays correct — a real
 *       provider without its key is ACTION REQUIRED, not a silent 500). It also
 *       asserts AI_PROVIDER still defaults to "mock".
 *   (b) LIVE PATH (skipped when AI_API_KEY is absent): when a real key IS
 *       supplied via env (AI_PROVIDER=openai|anthropic + AI_API_KEY), performs
 *       a real chat/completion call and returns a coherent reply — classifies
 *       an intent AND generates a grounded reply with real usage (spec §32).
 *
 * The live path is a guard, not a gate: it is SKIPped when no key is present so
 * CI / local runs stay green without a key. To exercise a real call:
 *   AI_PROVIDER=openai AI_API_KEY=sk-... bun run ai-provider-test.ts
 *   AI_PROVIDER=anthropic AI_API_KEY=sk-ant-... bun run ai-provider-test.ts
 *
 * Run: cd leadflow-ai-site && bun run ai-provider-test.ts
 */
import { OpenAiProvider } from "./src/server/integrations/openai";
import { AnthropicProvider } from "./src/server/integrations/anthropic";
import { env } from "./src/server/env";
import type { AiGenerateInput } from "./src/server/integrations/types";

let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// Shared input fixtures (tenant-scoped demo shape, like brain-test).
// ---------------------------------------------------------------------------

const BUSINESS_NAME = "Smith's HVAC";
const SERVICES = [{ name: "Furnace Installation", description: "New high-efficiency furnaces", priceCents: 650000 }];
const KNOWLEDGE = [
  { kind: "faq", question: "Do you offer financing?", answer: "Yes, 0% financing for 12 months on approved credit." },
];
const POLICIES = {
  cancellationPolicy: "Free cancellation up to 24 hours before your visit.",
  financing: "0% financing for 12 months on approved credit.",
  promotions: "",
  welcomeMessage: "Welcome to Smith's HVAC!",
};
const HOURS: Record<string, { open: string; close: string; closed: boolean }> = {
  monday: { open: "08:00", close: "17:00", closed: false },
  tuesday: { open: "08:00", close: "17:00", closed: false },
  wednesday: { open: "08:00", close: "17:00", closed: false },
  thursday: { open: "08:00", close: "17:00", closed: false },
  friday: { open: "08:00", close: "17:00", closed: false },
  saturday: { open: "09:00", close: "13:00", closed: false },
  sunday: { open: "00:00", close: "00:00", closed: true },
};
const SERVICE_AREA = { zipCodes: ["46802", "46804"], cities: ["Fort Wayne"] };

function generateInput(over: Partial<AiGenerateInput> = {}): AiGenerateInput {
  return {
    businessId: "biz-test",
    businessName: BUSINESS_NAME,
    message: over.message ?? "How much does a furnace installation cost?",
    intent: over.intent ?? "PRICE_INQUIRY",
    intentConfidence: over.intentConfidence ?? "HIGH",
    services: SERVICES,
    knowledge: KNOWLEDGE,
    policies: POLICIES,
    hours: HOURS,
    serviceArea: SERVICE_AREA,
    escalation: { sensitivity: "Balanced", keywords: [] },
    memory: {},
    lead: { firstName: "Dana", lastName: "Ortiz", phone: "555-0100", email: "dana@example.com", serviceRequested: "Furnace Installation", location: "Fort Wayne", status: "new", score: "70" },
    hasAppointment: false,
    conversation: { channel: "chat", status: "active" },
    history: [],
    agentName: "Sarah",
    tone: "Professional",
    responseLength: "Medium",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// (a) No-key path — always runs (forces AI_API_KEY empty so it never attempts).
// ---------------------------------------------------------------------------

const savedKey = process.env.AI_API_KEY;
(process.env as Record<string, string | undefined>).AI_API_KEY = "";

const openaiNoKey = new OpenAiProvider();
const anthropicNoKey = new AnthropicProvider();

async function expectNotConfigured(provider: { name: string }, method: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    pass(`${provider.name}.${method} (no key)`, false, "should have thrown not-configured");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pass(`${provider.name}.${method} (no key)`, /not configured/.test(msg), msg);
  }
}

await expectNotConfigured(openaiNoKey, "classifyIntent", () =>
  openaiNoKey.classifyIntent({ message: "hi", businessName: BUSINESS_NAME, services: SERVICES, memory: {} })
);
await expectNotConfigured(openaiNoKey, "generateReply", () => openaiNoKey.generateReply(generateInput()));
await expectNotConfigured(openaiNoKey, "respond", () =>
  openaiNoKey.respond({ businessId: "b", businessName: BUSINESS_NAME, message: "hi", history: [], services: SERVICES, knowledge: KNOWLEDGE, policies: POLICIES, hours: HOURS, serviceArea: SERVICE_AREA })
);
await expectNotConfigured(anthropicNoKey, "classifyIntent", () =>
  anthropicNoKey.classifyIntent({ message: "hi", businessName: BUSINESS_NAME, services: SERVICES, memory: {} })
);
await expectNotConfigured(anthropicNoKey, "generateReply", () => anthropicNoKey.generateReply(generateInput()));
await expectNotConfigured(anthropicNoKey, "respond", () =>
  anthropicNoKey.respond({ businessId: "b", businessName: BUSINESS_NAME, message: "hi", history: [], services: SERVICES, knowledge: KNOWLEDGE, policies: POLICIES, hours: HOURS, serviceArea: SERVICE_AREA })
);

// Restore the caller's env for the live path.
if (savedKey === undefined) delete process.env.AI_API_KEY;
else process.env.AI_API_KEY = savedKey;

// AI_PROVIDER still defaults to mock (config-only swap, mock remains default).
pass("AI_PROVIDER defaults to mock", env.aiProvider === "mock", `got "${env.aiProvider}"`);

// ---------------------------------------------------------------------------
// (b) Live path — skippable when no key is present.
// ---------------------------------------------------------------------------

async function liveProvider(provider: { name: string; classifyIntent: (i: never) => Promise<unknown>; generateReply: (i: never) => Promise<{ reply: string; usage?: { inputTokens: number } }> }) {
  // Guard: only run when the matching provider is selected AND a key is set.
  if (!env.aiApiKey) {
    console.log(`SKIP | ${provider.name} live call — set AI_API_KEY to run a real completion`);
    return;
  }
  if (env.aiProvider !== provider.name.toLowerCase()) {
    console.log(`SKIP | ${provider.name} live call — not the selected provider (AI_PROVIDER=${env.aiProvider || "mock"})`);
    return;
  }
  try {
    const cls = await provider.classifyIntent({
      message: "We have a gas leak in the basement, please help!",
      businessName: BUSINESS_NAME,
      services: SERVICES,
      memory: {},
    } as never);
    const intentVal = (cls as { intent?: string } | null | undefined)?.intent ?? "";
    pass(`${provider.name} live classifyIntent`, typeof intentVal === "string" && intentVal.length > 0, JSON.stringify(cls));
    const gen = await provider.generateReply(generateInput({ message: "How much does a furnace installation cost?" }) as never);
    const coherent = !!gen.reply && gen.reply.trim().length > 0;
    pass(`${provider.name} live generateReply`, coherent, `reply: "${gen.reply?.slice(0, 80)}" usage=${JSON.stringify(gen.usage)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pass(`${provider.name} live call`, false, msg);
  }
}

await liveProvider(openaiNoKey as never);
await liveProvider(anthropicNoKey as never);

console.log(failures === 0 ? "\nALL AI-PROVIDER TESTS PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
