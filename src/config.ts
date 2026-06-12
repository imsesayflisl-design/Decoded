import * as vscode from "vscode";
import type { ProviderId } from "./providers/types";

// Typed access to the decoded.* settings.

const VALID_PROVIDERS: ProviderId[] = [
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
];

export function getActiveProviderId(): ProviderId {
  const raw = vscode.workspace
    .getConfiguration("decoded")
    .get<string>("provider", "openai");
  return (VALID_PROVIDERS as string[]).includes(raw)
    ? (raw as ProviderId)
    : "openai";
}

// The model configured for a provider, or undefined to use its default.
export function getConfiguredModel(provider: ProviderId): string | undefined {
  return vscode.workspace
    .getConfiguration("decoded")
    .get<string>(`${provider}.model`);
}

export function getIncludeWarnings(): boolean {
  return vscode.workspace
    .getConfiguration("decoded")
    .get<boolean>("errors.includeWarnings", false);
}

export function getMaxListedErrors(): number {
  const n = vscode.workspace
    .getConfiguration("decoded")
    .get<number>("errors.maxListed", 50);
  return Math.max(1, Math.min(200, n));
}

export async function setActiveProviderId(id: ProviderId): Promise<void> {
  await vscode.workspace
    .getConfiguration("decoded")
    .update("provider", id, vscode.ConfigurationTarget.Global);
}

export async function setConfiguredModel(
  provider: ProviderId,
  model: string
): Promise<void> {
  await vscode.workspace
    .getConfiguration("decoded")
    .update(`${provider}.model`, model, vscode.ConfigurationTarget.Global);
}
