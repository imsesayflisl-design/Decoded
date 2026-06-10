import * as vscode from "vscode";

// Where an explanation came from, so "Apply fix" can edit the right place.
export interface ExplainSource {
  uri: vscode.Uri;
  range: vscode.Range;
}

// Opens the source file and replaces the diagnostic's line(s) with the
// corrected code. Returns false when the edit could not be applied.
export async function applyFix(
  source: ExplainSource,
  corrected: string
): Promise<boolean> {
  try {
    const doc = await vscode.workspace.openTextDocument(source.uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preserveFocus: false,
    });
    const ok = await editor.edit((builder) => {
      builder.replace(source.range, corrected);
    });
    if (ok) {
      vscode.window.showInformationMessage(
        "Decoded: Applied the fix. Use Undo (Ctrl+Z) if it's not what you wanted."
      );
    }
    return ok;
  } catch {
    vscode.window.showErrorMessage(
      "Decoded: Couldn't apply the fix — the file may have changed or closed."
    );
    return false;
  }
}
