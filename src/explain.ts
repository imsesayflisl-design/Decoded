import * as vscode from "vscode";
import { explainError, type ExplainInput } from "./providers/explain";
import { getActiveProvider } from "./providers";
import { resolveOrPromptAuth } from "./secrets";
import type { ExplainSource } from "./applyFix";
import type { DecodedChatViewProvider } from "./chatView";
import type { ConversationManager } from "./conversation";
import type { HistoryStore } from "./history";

// How many lines of context to gather on each side of a diagnostic.
const CONTEXT_RADIUS = 5;
// Caps to keep requests small/cheap and avoid sending huge inputs.
const MAX_ERROR_LEN = 2000;
const MAX_CODE_LEN = 6000;

// The resolved error + code context pulled from the editor.
export interface GatheredError {
  errorMessage: string;
  code: string;
  language: string;
  // Where the error came from — enables "Apply fix" to edit the right range.
  source: ExplainSource;
}

// Optional explicit target, passed by the lightbulb / CodeAction so we explain
// exactly the diagnostic the user clicked rather than re-reading the cursor.
export interface ExplainTarget {
  document: vscode.TextDocument;
  diagnostic: vscode.Diagnostic;
}

// Truncates overly long input, marking where it was cut.
function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n…(truncated)" : text;
}

// Applies the size caps to a gathered error, ready to send to the model.
export function toExplainInput(gathered: GatheredError): ExplainInput {
  return {
    errorMessage: cap(gathered.errorMessage, MAX_ERROR_LEN),
    code: cap(gathered.code, MAX_CODE_LEN),
    language: gathered.language,
  };
}

// Finds the diagnostic at the cursor, preferring the most severe one.
function diagnosticAtCursor(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.Diagnostic | undefined {
  const diagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .filter((d) => d.range.contains(position));
  if (diagnostics.length === 0) {
    return undefined;
  }
  // Lower severity number = more severe (Error=0, Warning=1, ...).
  diagnostics.sort((a, b) => a.severity - b.severity);
  return diagnostics[0];
}

// Builds the error + context for a specific diagnostic in a document.
export function gatherFromDiagnostic(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): GatheredError {
  const line = diagnostic.range.start.line;
  const startLine = Math.max(0, line - CONTEXT_RADIUS);
  const endLine = Math.min(document.lineCount - 1, line + CONTEXT_RADIUS);
  const contextRange = new vscode.Range(
    startLine,
    0,
    endLine,
    document.lineAt(endLine).text.length
  );
  // "Apply fix" replaces the full line(s) the diagnostic spans.
  const fixRange = new vscode.Range(
    diagnostic.range.start.line,
    0,
    diagnostic.range.end.line,
    document.lineAt(diagnostic.range.end.line).text.length
  );
  return {
    errorMessage: diagnostic.message,
    code: document.getText(contextRange),
    language: document.languageId,
    source: { uri: document.uri, range: fixRange },
  };
}

// Determines what to explain: diagnostic at cursor, else selection, else nothing.
// Returns undefined (after showing a message) when there is nothing to explain.
function gather(editor: vscode.TextEditor): GatheredError | undefined {
  const document = editor.document;
  const language = document.languageId;
  const position = editor.selection.active;

  const diagnostic = diagnosticAtCursor(document, position);
  if (diagnostic) {
    return gatherFromDiagnostic(document, diagnostic);
  }

  // No diagnostic — fall back to a non-empty selection.
  if (!editor.selection.isEmpty) {
    const selected = document.getText(editor.selection);
    return {
      errorMessage: selected,
      code: selected,
      language,
      source: { uri: document.uri, range: editor.selection },
    };
  }

  vscode.window.showInformationMessage(
    "Decoded: Place your cursor on an error (a squiggle) or select an error message, then run the command."
  );
  return undefined;
}

// Builds a short history title from the error message (first line, trimmed).
function titleFrom(errorMessage: string): string {
  const firstLine = errorMessage.split("\n")[0].trim();
  return firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
}

// The decoded.explainError command handler. An optional target is supplied by
// the lightbulb / CodeAction so we explain exactly that diagnostic; otherwise we
// read from the active editor's cursor or selection. Output renders in the
// sidebar chat view.
export async function runExplainError(
  context: vscode.ExtensionContext,
  history: HistoryStore,
  chatView: DecodedChatViewProvider,
  conversation: ConversationManager,
  target?: ExplainTarget
): Promise<void> {
  let gathered: GatheredError | undefined;

  // Only trust a target that actually carries a diagnostic + document. Some
  // menu contexts invoke commands with a URI as the first argument.
  if (target && target.diagnostic && target.document) {
    gathered = gatherFromDiagnostic(target.document, target.diagnostic);
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage(
        "Decoded: Open a file and place your cursor on an error first."
      );
      return;
    }
    gathered = gather(editor);
  }

  if (!gathered) {
    return;
  }

  const { provider, model } = getActiveProvider();
  const auth = await resolveOrPromptAuth(context, provider.id);
  if (!auth) {
    vscode.window.showWarningMessage(
      `Decoded: A ${provider.label} API key is required to explain errors.`
    );
    return;
  }

  const input: ExplainInput = toExplainInput(gathered);

  await chatView.focus();
  chatView.addUserMessage(titleFrom(gathered.errorMessage));
  chatView.setBusy(true, "Decoded is explaining the error…");
  try {
    const result = await explainError(
      provider,
      { apiKey: auth.apiKey, model, baseURL: auth.baseURL },
      input
    );
    chatView.addExplanation(result, gathered.source);
    conversation.startSession(input, result);
    await history.add(titleFrom(gathered.errorMessage), result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Friendly message in the chat, never an unhandled crash.
    chatView.addErrorMessage(message);
  } finally {
    chatView.setBusy(false);
  }
}
