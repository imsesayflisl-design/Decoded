import * as vscode from "vscode";

// Provides an "Explain with Decoded" quick-fix (lightbulb) on any diagnostic.
export class DecodedCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    // Only offer the action when there is a diagnostic in range.
    return context.diagnostics.map((diagnostic) => {
      const action = new vscode.CodeAction(
        "Explain with Decoded",
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diagnostic];
      // Pass the exact diagnostic + document so we explain what the user clicked.
      action.command = {
        command: "decoded.explainError",
        title: "Explain with Decoded",
        arguments: [{ document, diagnostic }],
      };
      return action;
    });
  }
}
