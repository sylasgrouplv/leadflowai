/**
 * OpenAI provider — STUB (spec §42).
 *
 * The interface is implemented and registered (AI_PROVIDER=openai), but a real
 * key is never used without an explicit owner decision: the swap is config-only
 * (set AI_API_KEY + AI_PROVIDER=openai). Until then every call throws a clear
 * error so a misconfiguration surfaces instead of silently degrading.
 *
 * Implementation note for the swap-in task: call the Chat Completions API with
 * the orchestrator context rendered as a system prompt + conversation history,
 * map the response to AiIntentResult / AiGeneratedReply, and enforce the global
 * safety rules in the prompt (never fabricate; answer only from context).
 */
import type { AiProvider, AiRequest, AiResponse, AiIntentInput, AiIntentResult, AiGenerateInput, AiGeneratedReply } from "./types";

const NOT_CONFIGURED =
  "AI provider 'openai' is not configured — set AI_API_KEY and AI_PROVIDER=openai to enable it. " +
  "The mock provider (AI_PROVIDER=mock, the default) keeps the app fully functional in the meantime.";

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";

  async classifyIntent(_input: AiIntentInput): Promise<AiIntentResult> {
    throw new Error(NOT_CONFIGURED);
  }
  async generateReply(_input: AiGenerateInput): Promise<AiGeneratedReply> {
    throw new Error(NOT_CONFIGURED);
  }
  async respond(_req: AiRequest): Promise<AiResponse> {
    throw new Error(NOT_CONFIGURED);
  }
}
