// The "Decoded: Diagnose Error" command flow. Reads a run/setup error from the
// active terminal's selection (or a pasted input box), gathers lightweight
// project context, asks the active provider (no key prompt), and renders the
// fix. A normal in-file code error falls back to the four-part explanation.
import * as vscode from "vscode";
import { diagnoseError } from "./providers/diagnose";
import { explainError } from "./providers/explain";
import { getActiveProvider } from "./providers";
import { resolveOrPromptAuth } from "./secrets";
import {
  gatherProjectContext,
  formatProjectContext,
} from "./projectContext";
import type { DecodedChatViewProvider } from "./chatView";

const MAX_ERROR_LEN = 2000;

function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n…(truncated)" : text;
}

function titleFrom(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
}

// Tries to read the current terminal selection by copying it to the clipboard
// and back, restoring the user's clipboard afterward. Returns undefined when
// there is no terminal or nothing is selected.
async function readTerminalSelection(): Promise<string | undefined> {
  if (!vscode.window.activeTerminal) {
    return undefined;
  }
  const before = await vscode.env.clipboard.readText();
  await vscode.commands.executeCommand(
    "workbench.action.terminal.copySelection"
  );
  const after = await vscode.env.clipboard.readText();
  // Restore whatever the user had on the clipboard.
  await vscode.env.clipboard.writeText(before);
  // copySelection only changes the clipboard when something was selected.
  return after && after.trim() && after !== before ? after : undefined;
}

export async function runDiagnose(
  context: vscode.ExtensionContext,
  chatView: DecodedChatViewProvider
): Promise<void> {
  let errorText = await readTerminalSelection();
  if (!errorText) {
    errorText = await vscode.window.showInputBox({
      title: "Decoded: Diagnose Error",
      prompt:
        "Paste the error from your terminal (e.g. the output of npm run dev).",
      placeHolder: "Error: Cannot find module 'next'",
      ignoreFocusOut: true,
    });
  }
  if (!errorText || !errorText.trim()) {
    return; // nothing to diagnose / user cancelled
  }
  errorText = cap(errorText.trim(), MAX_ERROR_LEN);

  const { provider, model } = getActiveProvider();
  const auth = await resolveOrPromptAuth(context, provider.id);
  if (!auth) {
    vscode.window.showWarningMessage(
      `Decoded: A ${provider.label} API key is required to diagnose errors.`
    );
    return;
  }
  const opts = { apiKey: auth.apiKey, model, baseURL: auth.baseURL };

  const ctx = await gatherProjectContext();
  const projectContext = ctx
    ? formatProjectContext(ctx)
    : "No workspace folder is open.";

  await chatView.focus();
  chatView.addUserMessage(titleFrom(errorText));
  chatView.setBusy(true, "Decoded is diagnosing the error…");
  try {
    const result = await diagnoseError(provider, opts, {
      errorText,
      projectContext,
    });
    if (result.category === "code") {
      // Not a setup problem — fall back to the existing four-part explanation.
      const explanation = await explainError(provider, opts, {
        errorMessage: errorText,
      });
      chatView.addExplanation(explanation);
    } else {
      chatView.addDiagnosis(result);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    chatView.addErrorMessage(message);
  } finally {
    chatView.setBusy(false);
  }
}
