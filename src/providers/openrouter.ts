import OpenAI from "openai";
import {
  ProviderError,
  type CompletionRequest,
  type LLMProvider,
  type ProviderOptions,
} from "./types";

// OpenRouter speaks the OpenAI chat-completions protocol, so we reuse the
// OpenAI SDK with a custom baseURL. The SDK throws the same error classes
// regardless of baseURL.
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Maps SDK errors to user-friendly messages.
function toProviderError(err: unknown): never {
  if (err instanceof OpenAI.AuthenticationError) {
    throw new ProviderError(
      "Your OpenRouter API key was rejected. Run “Decoded: Set API Key” to update it."
    );
  }
  if (err instanceof OpenAI.RateLimitError) {
    throw new ProviderError(
      "OpenRouter rate limit reached. Wait a moment and try again."
    );
  }
  if (err instanceof OpenAI.APIError) {
    throw new ProviderError(`OpenRouter API error: ${err.message}`);
  }
  throw err;
}

export const openrouterProvider: LLMProvider = {
  id: "openrouter",
  label: "OpenRouter",
  models: [
    "openrouter/auto",
    "meta-llama/llama-3.3-70b-instruct:free",
    "deepseek/deepseek-chat-v3-0324:free",
    "qwen/qwen3-coder:free",
    "qwen/qwen-2.5-72b-instruct",
  ],
  defaultModel: "openrouter/auto",
  keyPlaceholder: "sk-or-v1-...",

  async complete(
    req: CompletionRequest,
    opts: ProviderOptions
  ): Promise<string> {
    const client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: OPENROUTER_BASE_URL,
      // 2-minute timeout — free-tier models can queue and think for a while.
      timeout: 120000,
      maxRetries: 2,
      // Optional OpenRouter app attribution headers.
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/imsesayflisl-design/Decoded",
        "X-Title": "Decoded",
      },
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
        // Not every OpenRouter model supports it; failures surface as a clear
        // ProviderError so the user can pick another model via /model.
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
