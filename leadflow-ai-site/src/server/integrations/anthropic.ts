/**
 * Anthropic provider — STUB (spec §42).
 *
 * Same contract as the OpenAI stub: registered behind AI_PROVIDER=anthropic,
 * throws a clear "not configured" error until a real key is supplied
 * (AI_API_KEY). The swap is config-only; the mock remains the default.
 */
import type { AiProvider, AiRequest, AiResponse, AiIntentInput, AiIntentResult, AiGenerateInput, AiGeneratedReply } from "./types";

const NOT_CONFIGURED =
  "AI provider 'anthropic' is not configured — set AI_API_KEY and AI_PROVIDER=anthropic to enable it. " +
  "The mock provider (AI_PROVIDER=mock, the default) keeps the app fully functional in the meantime.";

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";

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
