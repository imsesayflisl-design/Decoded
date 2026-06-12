import { getActiveProviderId, getConfiguredModel } from "../config";
import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { openaiProvider } from "./openai";
import { openrouterProvider } from "./openrouter";
import type { LLMProvider, ProviderId } from "./types";

// All providers, in the order they appear in pickers.
export const PROVIDERS: LLMProvider[] = [
  anthropicProvider,
  openaiProvider,
  geminiProvider,
  openrouterProvider,
];

export function getProvider(id: ProviderId): LLMProvider {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return provider;
}

// The provider selected in settings, plus the model to use with it.
export function getActiveProvider(): { provider: LLMProvider; model: string } {
  const provider = getProvider(getActiveProviderId());
  const configured = getConfiguredModel(provider.id);
  const model =
    configured && provider.models.includes(configured)
      ? configured
      : provider.defaultModel;
  return { provider, model };
}
