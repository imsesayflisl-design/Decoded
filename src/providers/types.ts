// Shared types for the AI provider abstraction. Each provider is a dumb
// adapter: it takes a completion request and returns the model's text.
// All Decoded-specific logic (prompt, JSON contract, validation) lives in
// providers/explain.ts so it works identically for every provider.

export type ProviderId = "anthropic" | "openai" | "gemini" | "openrouter";

// One conversational turn, provider-neutral.
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// What a provider needs to produce a completion.
export interface CompletionRequest {
  system: string;
  // Alternating turns; the first must be "user".
  messages: ChatTurn[];
  maxTokens: number;
  // When set, the provider should use its native JSON/structured-output mode
  // so the response is guaranteed to parse. Optional — providers fall back to
  // plain text when omitted (used for conversational follow-ups).
  jsonSchema?: Record<string, unknown>;
}

export interface ProviderOptions {
  apiKey: string;
  model: string;
  // Overrides the provider's default API endpoint. Used by hosted mode to route
  // calls through the Decoded proxy (which injects the real key server-side).
  baseURL?: string;
}

export interface LLMProvider {
  readonly id: ProviderId;
  // Human-readable name, e.g. "Anthropic (Claude)".
  readonly label: string;
  readonly models: string[];
  readonly defaultModel: string;
  // Shown in the API-key input box, e.g. "sk-ant-...".
  readonly keyPlaceholder: string;
  // When onDelta is given and the request has no jsonSchema, providers
  // stream partial text as it's generated (the full text is still returned).
  // Structured (jsonSchema) requests never stream — partial JSON is useless.
  complete(
    req: CompletionRequest,
    opts: ProviderOptions,
    onDelta?: (delta: string) => void
  ): Promise<string>;
}

// Thrown by providers for auth/rate-limit/transport failures, with a message
// already phrased for the user.
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
