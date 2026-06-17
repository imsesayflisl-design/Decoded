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

// Maps SDK errors to user-friendly messages. `hosted` is true when the call
// went through the Decoded proxy (no user key involved), so an auth failure
// means the shared service is down — not that the user's key is bad.
function toProviderError(err: unknown, hosted: boolean): never {
  if (err instanceof Anthropic.AuthenticationError) {
    throw new ProviderError(
      hosted
        ? "Decoded's free hosted AI is temporarily unavailable. Try again shortly, or run “Decoded: Set API Key” to use your own Anthropic key."
        : "Your Anthropic API key was rejected. Run “Decoded: Set API Key” to update it."
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
    opts: ProviderOptions,
    onDelta?: (delta: string) => void
  ): Promise<string> {
    // 2-minute timeout so slow (thinking) responses still finish cleanly.
    // No sampling params and no `thinking` — both 400 on the newest models.
    const client = new Anthropic({
      apiKey: opts.apiKey,
      // Hosted mode points this at the Decoded proxy; otherwise the SDK default.
      baseURL: opts.baseURL,
      timeout: 120000,
      maxRetries: 2,
    });
    const messages = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    try {
      // Plain-text answers stream so the reply starts appearing right away.
      if (onDelta && !req.jsonSchema) {
        const stream = client.messages.stream({
          model: opts.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages,
        });
        stream.on("text", (delta) => onDelta(delta));
        const message = await stream.finalMessage();
        return responseText(message);
      }
      const message = await client.messages.create({
        model: opts.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages,
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
      toProviderError(err, Boolean(opts.baseURL));
    }
  },
};
