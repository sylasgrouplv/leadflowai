/**
 * Anthropic provider — real Messages API implementation (spec §42).
 *
 * Registered behind AI_PROVIDER=anthropic. When AI_API_KEY is set, this
 * provider calls the Anthropic Messages API (`/v1/messages`) via plain fetch
 * (no SDK dep — keeps the serverless bundle small). The model is read from
 * AI_MODEL (default `claude-3-5-haiku-latest` for low latency/cost). The mock
 * (AI_PROVIDER=mock) remains the default, so nothing talks to a live LLM until
 * an operator explicitly sets BOTH AI_PROVIDER=anthropic and AI_API_KEY — a
 * config-only swap, no code change.
 *
 *   classifies intents  → parses the model's JSON into the 13-intent taxonomy,
 *   generates replies  → grounds the reply in the business KB/context with the
 *                        global safety rules (never fabricate; clarify when
 *                        unknown), reports real usage (spec §32), and applies a
 *                        timeout so a slow/hung upstream never blocks the chat.
 *
 * No key configured → every call throws a clear "not configured" error so the
 * health check (§40) stays correct instead of silently degrading.
 *
 * Env: AI_PROVIDER=anthropic, AI_API_KEY (required), AI_MODEL (optional).
 */
import type {
  AiProvider,
  AiRequest,
  AiResponse,
  AiIntentInput,
  AiIntentResult,
  AiGenerateInput,
  AiGeneratedReply,
} from "./types";
import { env } from "../env";
import {
  buildClassifyPrompt,
  buildGenerateSystemPrompt,
  buildHistoryMessages,
  parseIntent,
  parseGenerate,
  postJson,
  estimateUsageFromTokens,
} from "./ai-prompt";

const DEFAULT_MODEL = "claude-3-5-haiku-latest";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const TIMEOUT_MS = 30_000;

const NOT_CONFIGURED =
  "AI provider 'anthropic' is not configured — set AI_API_KEY and AI_PROVIDER=anthropic to enable it. " +
  "The mock provider (AI_PROVIDER=mock, the default) keeps the app fully functional in the meantime.";

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";

  private key(): string {
    const k = env.aiApiKey;
    if (!k) throw new Error(NOT_CONFIGURED);
    return k;
  }

  private async chat(messages: { role: "system" | "user" | "assistant"; content: string }[]) {
    // Anthropic takes the system prompt separately; the rest become the
    // user/assistant turn, with the final user message appended by callers.
    const system =
      messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n") || undefined;
    const turns = messages.filter((m) => m.role !== "system");
    const body: Record<string, unknown> = {
      model: env.aiModel || DEFAULT_MODEL,
      max_tokens: 500,
      messages: turns as { role: "user" | "assistant"; content: string }[],
    };
    if (system) body.system = system;
    const { text } = await postJson(
      API_URL,
      {
        "x-api-key": this.key(),
        "anthropic-version": API_VERSION,
      },
      body,
      TIMEOUT_MS
    );
    let parsed: {
      content?: { type?: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("AI provider (anthropic) returned an unparseable response body");
    }
    const content = (parsed.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");
    const usage = parsed.usage;
    return {
      content,
      tokens:
        usage && typeof usage.input_tokens === "number"
          ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens ?? 0 }
          : undefined,
    };
  }

  async classifyIntent(input: AiIntentInput): Promise<AiIntentResult> {
    const { system, user } = buildClassifyPrompt({
      message: input.message,
      businessName: input.businessName,
      services: input.services,
    });
    const { content } = await this.chat([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    return parseIntent(content);
  }

  async generateReply(input: AiGenerateInput): Promise<AiGeneratedReply> {
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: buildGenerateSystemPrompt(input) },
    ];
    for (const m of buildHistoryMessages(input.history)) {
      messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: "user", content: input.message });
    const { content, tokens } = await this.chat(messages);
    const parsed = parseGenerate(content);
    const usage = estimateUsageFromTokens(input, parsed.reply, tokens);
    return { ...parsed, usage };
  }

  // Legacy single-shot path — kept for compatibility; classifies then generates.
  async respond(req: AiRequest): Promise<AiResponse> {
    const cls = await this.classifyIntent({
      message: req.message,
      businessName: req.businessName,
      services: req.services,
      memory: {},
    });
    const gen = await this.generateReply({
      businessId: req.businessId,
      businessName: req.businessName,
      message: req.message,
      intent: cls.intent,
      intentConfidence: cls.confidence,
      services: req.services,
      knowledge: req.knowledge,
      policies: req.policies,
      hours: req.hours,
      serviceArea: req.serviceArea,
      escalation: req.escalation ?? { sensitivity: "medium", keywords: [] },
      memory: {},
      lead: null,
      hasAppointment: false,
      conversation: { channel: "chat", status: "active" },
      history: req.history,
    });
    const intent: AiResponse["intent"] =
      cls.intent === "APPOINTMENT_REQUEST" || cls.intent === "APPOINTMENT_CHANGE" || cls.intent === "APPOINTMENT_CANCEL"
        ? "book"
        : ["COMPLAINT", "REFUND_REQUEST", "HUMAN_REQUEST", "EMERGENCY", "APPOINTMENT_CANCEL"].includes(cls.intent)
          ? "escalate"
          : cls.intent === "UNKNOWN"
            ? "unknown"
            : "answer";
    const confidence = cls.confidence === "HIGH" ? 0.9 : cls.confidence === "MEDIUM" ? 0.6 : 0.3;
    return { reply: gen.reply, intent, confidence };
  }
}
