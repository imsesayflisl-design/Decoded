import {
  ProviderError,
  type CompletionRequest,
  type LLMProvider,
  type ProviderOptions,
} from "./types";

// @google/genai is ESM-only while this extension compiles as CommonJS, so it
// is loaded with a dynamic import (esbuild bundles it either way).
type GenAIModule = typeof import("@google/genai", {
  with: { "resolution-mode": "import" },
});
let genAIModule: Promise<GenAIModule> | undefined;
function loadGenAI(): Promise<GenAIModule> {
  genAIModule ??= import("@google/genai");
  return genAIModule;
}

// Maps SDK errors to user-friendly messages.
function toProviderError(genai: GenAIModule, err: unknown): never {
  if (err instanceof genai.ApiError) {
    if (err.status === 401 || err.status === 403) {
      throw new ProviderError(
        "Your Google API key was rejected. Run “Decoded: Set API Key” to update it."
      );
    }
    if (err.status === 429) {
      throw new ProviderError(
        "Gemini rate limit reached. Wait a moment and try again."
      );
    }
    throw new ProviderError(`Gemini API error: ${err.message}`);
  }
  throw err;
}

export const geminiProvider: LLMProvider = {
  id: "gemini",
  label: "Google (Gemini)",
  models: ["gemini-3.5-flash", "gemini-2.5-pro", "gemini-3.1-flash-lite"],
  defaultModel: "gemini-3.5-flash",
  keyPlaceholder: "AIza...",

  async complete(
    req: CompletionRequest,
    opts: ProviderOptions
  ): Promise<string> {
    const genai = await loadGenAI();
    const ai = new genai.GoogleGenAI({ apiKey: opts.apiKey });
    try {
      const response = await ai.models.generateContent({
        model: opts.model,
        // Gemini calls the assistant role "model".
        contents: req.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        config: {
          systemInstruction: req.system,
          maxOutputTokens: req.maxTokens,
          // Native JSON mode guarantees parseable JSON when requested.
          ...(req.jsonSchema
            ? {
                responseMimeType: "application/json",
                responseSchema: req.jsonSchema,
              }
            : {}),
        },
      });
      return response.text ?? "";
    } catch (err) {
      toProviderError(genai, err);
    }
  },
};
