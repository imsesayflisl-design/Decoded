import OpenAI from "openai";
import {
  ProviderError,
  type CompletionRequest,
  type LLMProvider,
  type ProviderOptions,
} from "./types";

// Maps SDK errors to user-friendly messages.
function toProviderError(err: unknown): never {
  if (err instanceof OpenAI.AuthenticationError) {
    throw new ProviderError(
      "Your OpenAI API key was rejected. Run “Decoded: Set API Key” to update it."
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
  models: ["gpt-5-mini", "gpt-5", "gpt-4.1", "gpt-4o-mini"],
  defaultModel: "gpt-5-mini",
  keyPlaceholder: "sk-...",

  async complete(
    req: CompletionRequest,
    opts: ProviderOptions
  ): Promise<string> {
    const client = new OpenAI({
      apiKey: opts.apiKey,
      timeout: 30000,
      maxRetries: 1,
    });
    try {
      const completion = await client.chat.completions.create({
        model: opts.model,
        max_completion_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          ...req.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        ],
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
      toProviderError(err);
    }
  },
};
