import * as vscode from "vscode";
import { getIncludeWarnings, getMaxListedErrors } from "./config";

// What the sidebar shows for one problem. Serializable for postMessage.
export interface ErrorItem {
  key: string;
  message: string;
  file: string;
  line: number; // 1-based, for display
  severity: "error" | "warning";
}

const DEBOUNCE_MS = 400;

// Stable identity for a diagnostic so webview clicks can be resolved back to
// the live object (and so list diffs are cheap).
function keyFor(uri: vscode.Uri, d: vscode.Diagnostic): string {
  return [
    uri.toString(),
    d.range.start.line,
    d.range.start.character,
    d.range.end.line,
    d.range.end.character,
    d.message,
  ].join("|");
}

// Watches workspace diagnostics (debounced) and keeps a snapshot of current
// errors for the sidebar. NEVER calls any AI API — listing is free; the
// model only runs when the user clicks an item.
export class DiagnosticsWatcher implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ErrorItem[]>();
  readonly onDidChangeErrors = this.emitter.event;

  private readonly live = new Map<
    string,
    { uri: vscode.Uri; diagnostic: vscode.Diagnostic }
  >();
  private lastEmitted = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.languages.onDidChangeDiagnostics(() =>
      this.schedule()
    );
    this.schedule();
  }

  // The current snapshot (used to seed a freshly opened webview).
  current(): ErrorItem[] {
    return this.snapshot().items;
  }

  // Resolves a webview click back to the live diagnostic, or undefined if it
  // has disappeared since the list was rendered.
  resolve(
    key: string
  ): { uri: vscode.Uri; diagnostic: vscode.Diagnostic } | undefined {
    return this.live.get(key);
  }

  // Forces a refresh notification (e.g. when the view becomes visible).
  refresh(): void {
    this.lastEmitted = "";
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const { items, serialized } = this.snapshot();
      if (serialized !== this.lastEmitted) {
        this.lastEmitted = serialized;
        this.emitter.fire(items);
      }
    }, DEBOUNCE_MS);
  }

  private snapshot(): { items: ErrorItem[]; serialized: string } {
    const includeWarnings = getIncludeWarnings();
    const maxListed = getMaxListedErrors();

    const collected: { uri: vscode.Uri; diagnostic: vscode.Diagnostic }[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      for (const d of diagnostics) {
        if (
          d.severity === vscode.DiagnosticSeverity.Error ||
          (includeWarnings && d.severity === vscode.DiagnosticSeverity.Warning)
        ) {
          collected.push({ uri, diagnostic: d });
        }
      }
    }

    // Errors before warnings, then by file and position.
    collected.sort((a, b) => {
      if (a.diagnostic.severity !== b.diagnostic.severity) {
        return a.diagnostic.severity - b.diagnostic.severity;
      }
      const file = a.uri.toString().localeCompare(b.uri.toString());
      if (file !== 0) {
        return file;
      }
      return a.diagnostic.range.start.line - b.diagnostic.range.start.line;
    });

    const capped = collected.slice(0, maxListed);

    this.live.clear();
    const items: ErrorItem[] = capped.map(({ uri, diagnostic }) => {
      const key = keyFor(uri, diagnostic);
      this.live.set(key, { uri, diagnostic });
      return {
        key,
        message: diagnostic.message,
        file: vscode.workspace.asRelativePath(uri),
        line: diagnostic.range.start.line + 1,
        severity:
          diagnostic.severity === vscode.DiagnosticSeverity.Error
            ? "error"
            : "warning",
      };
    });

    return { items, serialized: JSON.stringify(items.map((i) => i.key)) };
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
