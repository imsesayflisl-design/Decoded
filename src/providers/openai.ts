import OpenAI from "openai";
import {
  ProviderError,
  type CompletionRequest,
  type LLMProvider,
  type ProviderOptions,
} from "./types";

// Maps SDK errors to user-friendly messages. `hosted` is true when the call
// went through the Decoded proxy (no user key involved), so an auth failure
// means the shared service is down — not that the user's key is bad.
function toProviderError(err: unknown, hosted: boolean): never {
  if (err instanceof OpenAI.AuthenticationError) {
    throw new ProviderError(
      hosted
        ? "Decoded's free hosted AI is temporarily unavailable. Try again shortly, or run “Decoded: Set API Key” to use your own OpenAI key."
        : "Your OpenAI API key was rejected. Run “Decoded: Set API Key” to update it."
    );
  }
  if (err instanceof OpenAI.RateLimitError) {
    throw new ProviderError(
      "OpenAI rate limit reached. Wait a moment and try again."
    );
  }
  if (err instanceof OpenAI.APIError) {
    throw new ProviderError(`OpenAI API error: ${err.message}`);
  }
  throw err;
}

export const openaiProvider: LLMProvider = {
  id: "openai",
  label: "OpenAI (GPT)",
  models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
  defaultModel: "gpt-5.4-mini",
  keyPlaceholder: "sk-...",

  async complete(
    req: CompletionRequest,
    opts: ProviderOptions,
    onDelta?: (delta: string) => void
  ): Promise<string> {
    // 2-minute timeout — reasoning models can think well past 30s.
    const client = new OpenAI({
      apiKey: opts.apiKey,
      // Hosted mode points this at the Decoded proxy; otherwise the SDK default.
      baseURL: opts.baseURL,
      timeout: 120000,
      maxRetries: 2,
    });
    const messages = [
      { role: "system" as const, content: req.system },
      ...req.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];
    try {
      // Plain-text answers stream so the reply starts appearing right away.
      if (onDelta && !req.jsonSchema) {
        const stream = await client.chat.completions.create({
          model: opts.model,
          max_completion_tokens: req.maxTokens,
          messages,
          stream: true,
        });
        let full = "";
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        }
        return full;
      }
      const completion = await client.chat.completions.create({
        model: opts.model,
        max_completion_tokens: req.maxTokens,
        messages,
        // Strict structured output guarantees parseable JSON when requested.
        ...(req.jsonSchema
          ? {
              response_format: {
                type: "json_schema" as const,
                json_schema: {
                  name: "explanation",
                  strict: true,
                  schema: req.jsonSchema,
                },
              },
            }
          : {}),
      });
      return completion.choices[0]?.message?.content ?? "";
    } catch (err) {
      toProviderError(err, Boolean(opts.baseURL));
    }
  },
};
