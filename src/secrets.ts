import * as vscode from "vscode";
import type { LLMProvider, ProviderId } from "./providers/types";
import { getProvider, PROVIDERS } from "./providers";
import { getEnvFileApiKey } from "./envFile";

// One SecretStorage key per provider. Keys are NEVER written to settings,
// code, or logs.
export function secretKeyFor(provider: ProviderId): string {
  return `decoded.apiKey.${provider}`;
}

// The pre-multi-provider key, migrated on activation.
const LEGACY_ANTHROPIC_KEY = "decoded.anthropicApiKey";

// One-time migration: copy the old Anthropic key to the per-provider slot so
// existing users don't have to re-enter it.
export async function migrateLegacyApiKey(
  context: vscode.ExtensionContext
): Promise<void> {
  const legacy = await context.secrets.get(LEGACY_ANTHROPIC_KEY);
  if (!legacy) {
    return;
  }
  const existing = await context.secrets.get(secretKeyFor("anthropic"));
  if (!existing) {
    await context.secrets.store(secretKeyFor("anthropic"), legacy);
  }
  await context.secrets.delete(LEGACY_ANTHROPIC_KEY);
}

// Returns the key for a provider: SecretStorage first, then a .env.local
// fallback (so keys in that file are picked up without any prompt).
export async function getApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderId
): Promise<string | undefined> {
  const stored = await context.secrets.get(secretKeyFor(provider));
  if (stored) {
    return stored;
  }
  return getEnvFileApiKey(context, provider);
}

export async function storeApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderId,
  key: string
): Promise<void> {
  await context.secrets.store(secretKeyFor(provider), key.trim());
}

// Prompts for a provider's key (password input).
async function promptForKey(
  provider: LLMProvider
): Promise<string | undefined> {
  const entered = await vscode.window.showInputBox({
    title: `Decoded — ${provider.label} API Key`,
    prompt: `Enter your ${provider.label} API key. It is stored securely in your editor's secret storage.`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: provider.keyPlaceholder,
  });
  return entered && entered.trim() ? entered.trim() : undefined;
}

// Reads the key for a provider, prompting and storing it if missing.
// Returns undefined if the user cancels the prompt.
export async function ensureApiKey(
  context: vscode.ExtensionContext,
  providerId: ProviderId
): Promise<string | undefined> {
  const existing = await getApiKey(context, providerId);
  if (existing) {
    return existing;
  }
  const entered = await promptForKey(getProvider(providerId));
  if (!entered) {
    return undefined;
  }
  await storeApiKey(context, providerId, entered);
  return entered;
}

// QuickPick over the three providers; returns undefined on cancel.
async function pickProvider(
  placeHolder: string
): Promise<LLMProvider | undefined> {
  const picked = await vscode.window.showQuickPick(
    PROVIDERS.map((p) => ({ label: p.label, id: p.id })),
    { placeHolder }
  );
  return picked ? getProvider(picked.id) : undefined;
}

// "Decoded: Set API Key" — pick a provider, then prompt and overwrite its key.
export async function setApiKeyCommand(
  context: vscode.ExtensionContext
): Promise<void> {
  const provider = await pickProvider("Which provider's API key do you want to set?");
  if (!provider) {
    return;
  }
  const entered = await promptForKey(provider);
  if (!entered) {
    return; // user cancelled — leave any existing key untouched
  }
  await storeApiKey(context, provider.id, entered);
  vscode.window.showInformationMessage(
    `Decoded: ${provider.label} API key saved securely.`
  );
}

// "Decoded: Clear API Keys" — pick one provider (or all), then remove the
// stored key(s).
export async function clearApiKeyCommand(
  context: vscode.ExtensionContext
): Promise<void> {
  const ALL = "__all__";
  const picked = await vscode.window.showQuickPick(
    [
      ...PROVIDERS.map((p) => ({ label: p.label, id: p.id as string })),
      { label: "All providers", id: ALL },
    ],
    { placeHolder: "Which provider's API key do you want to clear?" }
  );
  if (!picked) {
    return;
  }
  if (picked.id === ALL) {
    let cleared = 0;
    for (const p of PROVIDERS) {
      // Check secret storage directly — env-file keys can't be cleared here.
      const existing = await context.secrets.get(secretKeyFor(p.id));
      if (existing) {
        await context.secrets.delete(secretKeyFor(p.id));
        cleared++;
      }
    }
    vscode.window.showInformationMessage(
      cleared > 0
        ? `Decoded: Cleared ${cleared} API key${cleared === 1 ? "" : "s"}.`
        : "Decoded: No API keys are currently set."
    );
    return;
  }
  const provider = getProvider(picked.id as ProviderId);
  const existing = await context.secrets.get(secretKeyFor(provider.id));
  if (!existing) {
    vscode.window.showInformationMessage(
      `Decoded: No ${provider.label} API key is currently set.`
    );
    return;
  }
  await context.secrets.delete(secretKeyFor(provider.id));
  vscode.window.showInformationMessage(
    `Decoded: ${provider.label} API key cleared.`
  );
}
