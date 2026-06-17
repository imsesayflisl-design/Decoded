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
  // Default to OpenRouter so a fresh install works on free models with no
  // funded account (matches the hosted proxy's free-by-default setup).
  const raw = vscode.workspace
    .getConfiguration("decoded")
    .get<string>("provider", "openrouter");
  return (VALID_PROVIDERS as string[]).includes(raw)
    ? (raw as ProviderId)
    : "openrouter";
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

// Whether to auto-detect failed terminal commands (capture only — the AI runs
// only when the user clicks Explain).
export function getTerminalAutoDetect(): boolean {
  return vscode.workspace
    .getConfiguration("decoded")
    .get<boolean>("terminal.autoDetect", true);
}

// Whether Decoded scans the codebase in the background (on open + on save) and
// shows a notification when new errors appear. Capture/notify only — the AI
// runs only when the user clicks a problem.
export function getCodebaseAutoScan(): boolean {
  return vscode.workspace
    .getConfiguration("decoded")
    .get<boolean>("codebase.autoScan", true);
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
