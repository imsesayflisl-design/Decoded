import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderError,
  type CompletionRequest,
  type LLMProvider,
  type ProviderOptions,
} from "./types";

// Reads the text out of an Anthropic message response.
function responseText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// Maps SDK errors to user-friendly messages.
function toProviderError(err: unknown): never {
  if (err instanceof Anthropic.AuthenticationError) {
    throw new ProviderError(
      "Your Anthropic API key was rejected. Run “Decoded: Set API Key” to update it."
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    throw new ProviderError(
      "Anthropic rate limit reached. Wait a moment and try again."
    );
  }
  if (err instanceof Anthropic.APIError) {
    throw new ProviderError(`Anthropic API error: ${err.message}`);
  }
  throw err;
}

export const anthropicProvider: LLMProvider = {
  id: "anthropic",
  label: "Anthropic (Claude)",
  models: [
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
  defaultModel: "claude-opus-4-8",
  keyPlaceholder: "sk-ant-...",

  async complete(
    req: CompletionRequest,
    opts: ProviderOptions
  ): Promise<string> {
    // 30s timeout so a hung request fails cleanly; one transport retry.
    // No sampling params and no `thinking` — both 400 on the newest models.
    const client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: 30000,
      maxRetries: 1,
    });
    try {
      const message = await client.messages.create({
        model: opts.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        // Native structured output guarantees parseable JSON when requested.
        ...(req.jsonSchema
          ? {
              output_config: {
                format: { type: "json_schema", schema: req.jsonSchema },
              },
            }
          : {}),
      });
      return responseText(message);
    } catch (err) {
      toProviderError(err);
    }
  },
};
