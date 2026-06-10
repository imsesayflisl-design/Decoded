import * as vscode from "vscode";
import { gatherFromDiagnostic, toExplainInput } from "./explain";
import { explainError } from "./providers/explain";
import { getActiveProvider } from "./providers";
import { ensureApiKey } from "./secrets";
import type { DecodedChatViewProvider } from "./chatView";
import type { DiagnosticsWatcher, ErrorItem } from "./diagnostics";
import type { HistoryStore } from "./history";

// Safety caps: one confirmation from the user covers at most this many
// AI calls/edits per run.
const MAX_FIXES = 10;
// Time for language servers to re-publish diagnostics after each edit.
const SETTLE_MS = 1200;

function shortTitle(message: string): string {
  const firstLine = message.split("\n")[0].trim();
  return firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
}

// Re-finds the live diagnostic for a listed error (ranges shift after each
// fix, so match by message — nearest occurrence wins).
function findLiveDiagnostic(
  uri: vscode.Uri,
  item: ErrorItem
): vscode.Diagnostic | undefined {
  const candidates = vscode.languages
    .getDiagnostics(uri)
    .filter((d) => d.message === item.message);
  if (candidates.length === 0) {
    return undefined;
  }
  candidates.sort(
    (a, b) =>
      Math.abs(a.range.start.line - (item.line - 1)) -
      Math.abs(b.range.start.line - (item.line - 1))
  );
  return candidates[0];
}

// Fixes listed errors one by one: explain via the active provider, then
// replace the broken line(s) with the model's corrected code. Runs ONLY after
// the user has said yes in the chat. Files are left unsaved so Undo works.
export async function fixAllErrors(
  context: vscode.ExtensionContext,
  chatView: DecodedChatViewProvider,
  watcher: DiagnosticsWatcher,
  history: HistoryStore
): Promise<void> {
  const { provider, model } = getActiveProvider();
  const apiKey = await ensureApiKey(context, provider.id);
  if (!apiKey) {
    vscode.window.showWarningMessage(
      `Decoded: A ${provider.label} API key is required to fix errors.`
    );
    return;
  }

  const attempted = new Set<string>();
  let fixed = 0;
  let failed = 0;

  chatView.setBusy(true, "Decoded is fixing errors…");
  try {
    for (let round = 0; round < MAX_FIXES; round++) {
      // Fresh snapshot each round — earlier fixes may have removed (or
      // moved) later errors.
      const next = watcher
        .current()
        .find((e) => e.severity === "error" && !attempted.has(e.key));
      if (!next) {
        break;
      }
      attempted.add(next.key);

      const resolved = watcher.resolve(next.key);
      if (!resolved) {
        continue;
      }

      const location = `${next.file}:${next.line}`;
      try {
        const document = await vscode.workspace.openTextDocument(resolved.uri);
        const live = findLiveDiagnostic(resolved.uri, next);
        if (!live) {
          continue; // already gone — an earlier fix resolved it
        }

        chatView.setBusy(
          true,
          `Fixing ${fixed + failed + 1}: ${shortTitle(next.message)}`
        );
        const gathered = gatherFromDiagnostic(document, live);
        const result = await explainError(
          provider,
          { apiKey, model },
          toExplainInput(gathered)
        );

        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          gathered.source.uri,
          gathered.source.range,
          result.howToFix.correctedCode
        );
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
          failed++;
          chatView.addErrorMessage(`Couldn't edit ${location} — skipped.`);
          continue;
        }

        fixed++;
        await history.add(shortTitle(next.message), result);
        chatView.addAssistantMarkdown(
          `**Fixed** \`${location}\` — ${result.whatItMeans.explanation}\n\n` +
            "```" +
            `${gathered.language}\n${result.howToFix.correctedCode}\n` +
            "```"
        );

        // Let diagnostics settle before picking the next error.
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        chatView.addErrorMessage(`Couldn't fix ${location}: ${message}`);
      }
    }

    const remaining = watcher
      .current()
      .filter((e) => e.severity === "error").length;
    if (fixed === 0 && failed === 0) {
      chatView.addAssistantMarkdown(
        "No errors to fix — your code is already clean."
      );
    } else {
      const parts = [`**Done.** Fixed ${fixed} error${fixed === 1 ? "" : "s"}.`];
      if (failed > 0) {
        parts.push(`${failed} couldn't be fixed automatically.`);
      }
      if (remaining > 0) {
        parts.push(`${remaining} still remaining — run another scan or fix.`);
      }
      parts.push(
        "The changes are unsaved, so review each file and use Undo (Ctrl+Z) if a fix isn't what you wanted."
      );
      chatView.addAssistantMarkdown(parts.join(" "));
    }
  } finally {
    chatView.setBusy(false);
  }
}
