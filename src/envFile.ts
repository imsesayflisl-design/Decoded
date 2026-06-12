import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ProviderId } from "./providers/types";

// Optional .env.local support: lets users keep API keys in a gitignored file
// instead of pasting them into the editor. SecretStorage always wins; this is
// only the fallback (see secrets.ts).

// Accepted variable names per provider. GOOGLE_API_KEY is the name Google AI
// Studio shows, so it's accepted as an alias for the Gemini key.
const ENV_KEYS: Record<ProviderId, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

// Minimal KEY=value parser: blank lines and # comments are skipped, an
// optional `export ` prefix is allowed, and one pair of surrounding quotes
// is stripped from the value.
export function parseEnvFile(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line
    );
    if (!match || line.trimStart().startsWith("#")) {
      continue;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars.set(match[1], value);
  }
  return vars;
}

// .env.local locations, in priority order: each open workspace folder, then
// the extension's own folder (covers Extension Development Host runs).
function candidateEnvFiles(context: vscode.ExtensionContext): string[] {
  const roots = (vscode.workspace.workspaceFolders ?? []).map(
    (f) => f.uri.fsPath
  );
  roots.push(context.extensionPath);
  return roots.map((root) => path.join(root, ".env.local"));
}

// Returns the provider's key from the first .env.local that defines a
// non-empty value, or undefined. Empty values (placeholder lines like
// `OPENROUTER_API_KEY=`) don't count.
export function getEnvFileApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderId
): string | undefined {
  for (const file of candidateEnvFiles(context)) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // file absent or unreadable — try the next location
    }
    const vars = parseEnvFile(text);
    for (const name of ENV_KEYS[provider]) {
      const value = vars.get(name);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}
