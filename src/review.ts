// The "Decoded: Review File" command flow. Mirrors runExplainError: gather the
// whole active file + all its diagnostics, send to the active provider (no key
// prompt), and render the issue list in the sidebar.
import * as vscode from "vscode";
import { reviewFile } from "./providers/review";
import { getActiveProvider } from "./providers";
import { resolveOrPromptAuth } from "./secrets";
import type { DecodedChatViewProvider } from "./chatView";

// Cap the file we send to keep requests small/cheap.
const MAX_FILE_LEN = 8000;

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n…(truncated)" : text;
}

// All errors+warnings for a file, most-severe first, as "[error] line N: msg".
function gatherDiagnostics(uri: vscode.Uri): string {
  const items = vscode.languages
    .getDiagnostics(uri)
    .filter(
      (d) =>
        d.severity === vscode.DiagnosticSeverity.Error ||
        d.severity === vscode.DiagnosticSeverity.Warning
    )
    .sort((a, b) => a.severity - b.severity)
    .map((d) => {
      const sev =
        d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
      return `[${sev}] line ${d.range.start.line + 1}: ${d.message}`;
    });
  return items.length > 0 ? items.join("\n") : "None reported by the editor.";
}

export async function runReviewFile(
  context: vscode.ExtensionContext,
  chatView: DecodedChatViewProvider
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage(
      "Decoded: Open a file to review first."
    );
    return;
  }
  const document = editor.document;
  const fileName = document.uri.path.split("/").pop() ?? "this file";
  const code = cap(document.getText(), MAX_FILE_LEN);
  const language = document.languageId;
  const diagnostics = gatherDiagnostics(document.uri);

  const { provider, model } = getActiveProvider();
  const auth = await resolveOrPromptAuth(context, provider.id);
  if (!auth) {
    vscode.window.showWarningMessage(
      `Decoded: A ${provider.label} API key is required to review files.`
    );
    return;
  }

  await chatView.focus();
  chatView.addUserMessage(`Review: ${fileName}`);
  chatView.setBusy(true, "Decoded is reviewing the file…");
  try {
    const result = await reviewFile(
      provider,
      { apiKey: auth.apiKey, model, baseURL: auth.baseURL },
      { fileName, language, code, diagnostics }
    );
    chatView.addReview(
      result.summary,
      result.issues,
      document.uri.toString(),
      language
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    chatView.addErrorMessage(message);
  } finally {
    chatView.setBusy(false);
  }
}
