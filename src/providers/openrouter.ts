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

// Free models share a global upstream pool and frequently return 429. We retry
// a couple of times, honouring the server's Retry-After (capped) so transient
// rate-limits recover silently instead of erroring out to the user.
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 30000;

// The Decoded "auto" model: instead of OpenRouter's PAID auto-router
// (openrouter/auto), it tries these free models in order and falls back to the
// next one on a rate-limit (429), so it stays $0 while dodging busy upstreams.
const AUTO_MODEL = "auto";
const FREE_MODELS = [
  "qwen/qwen3-coder:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// How long to wait before a retry: the Retry-After header if present (seconds),
// otherwise a small default, capped so we never hang past the request timeout.
function retryWaitMs(err: InstanceType<typeof OpenAI.RateLimitError>): number {
  const header = err.headers?.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  const ms = Number.isFinite(seconds) ? seconds * 1000 : 3000;
  return Math.min(Math.max(ms, 1000), MAX_RETRY_WAIT_MS);
}

// Maps SDK errors to user-friendly messages. `hosted` is true when the call
// went through the Decoded proxy (no user key involved), so an auth failure
// means the shared service is down — not that the user's key is bad.
function toProviderError(err: unknown, hosted: boolean): never {
  if (err instanceof OpenAI.AuthenticationError) {
    throw new ProviderError(
      hosted
        ? "Decoded's free hosted AI is temporarily unavailable. Try again shortly, or run “Decoded: Set API Key” to use your own OpenRouter key."
        : "Your OpenRouter API key was rejected. Run “Decoded: Set API Key” to update it."
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
    "auto",
    "qwen/qwen3-coder:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "openrouter/auto",
    "qwen/qwen-2.5-72b-instruct",
  ],
  // "auto" (smart free routing) by default so a fresh install / hosted mode
  // works with no funded account and survives a busy free model.
  defaultModel: AUTO_MODEL,
  keyPlaceholder: "sk-or-v1-...",

  async complete(
    req: CompletionRequest,
    opts: ProviderOptions,
    onDelta?: (delta: string) => void
  ): Promise<string> {
    const client = new OpenAI({
      apiKey: opts.apiKey,
      // Hosted mode routes through the Decoded proxy; otherwise straight to OpenRouter.
      baseURL: opts.baseURL ?? OPENROUTER_BASE_URL,
      // 2-minute timeout — free-tier models can queue and think for a while.
      timeout: 120000,
      maxRetries: 2,
      // Optional OpenRouter app attribution headers.
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/imsesayflisl-design/Decoded",
        "X-Title": "Decoded",
      },
    });
    const messages = [
      { role: "system" as const, content: req.system },
      ...req.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    // One request against a specific model id; returns the reply text.
    const attemptWith = async (model: string): Promise<string> => {
      // Plain-text answers stream so the reply starts appearing right away.
      if (onDelta && !req.jsonSchema) {
        const stream = await client.chat.completions.create({
          model,
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
        model,
        max_completion_tokens: req.maxTokens,
        messages,
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
    };

    // "auto" tries each free model; any other id is used as-is. On a 429 we move
    // to the next candidate, and once every candidate is rate-limited we wait
    // out the Retry-After and try the whole set again.
    const candidates = opts.model === AUTO_MODEL ? FREE_MODELS : [opts.model];
    let lastRateLimit: InstanceType<typeof OpenAI.RateLimitError> | undefined;
    for (let pass = 0; pass <= MAX_RATE_LIMIT_RETRIES; pass++) {
      for (const model of candidates) {
        try {
          return await attemptWith(model);
        } catch (err) {
          if (err instanceof OpenAI.RateLimitError) {
            lastRateLimit = err;
            continue; // busy upstream — try the next free model
          }
          toProviderError(err, Boolean(opts.baseURL));
        }
      }
      if (lastRateLimit && pass < MAX_RATE_LIMIT_RETRIES) {
        await sleep(retryWaitMs(lastRateLimit));
      }
    }
    toProviderError(lastRateLimit, Boolean(opts.baseURL));
  },
};
