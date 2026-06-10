import * as vscode from "vscode";
import type { Explanation } from "./schema";
import { applyFix, type ExplainSource } from "./applyFix";
import type { HistoryStore } from "./history";
import type { ErrorItem } from "./diagnostics";
import { getActiveProvider } from "./providers";

// An action button shown on a prompt card ("Yes, fix them" / "Not now").
export interface PromptAction {
  label: string;
  action: string;
}

// Transcript items are kept extension-side so the webview can be rebuilt
// after the sidebar is hidden and reshown.
type TranscriptItem =
  | { kind: "user"; id: string; title: string }
  | {
      kind: "explanation";
      id: string;
      explanation: Explanation;
      canApplyFix: boolean;
    }
  | { kind: "assistant"; id: string; markdown: string }
  | { kind: "error"; id: string; message: string }
  | { kind: "prompt"; id: string; text: string; actions: PromptAction[] };

interface HistorySummary {
  id: string;
  title: string;
  language: string;
  timestamp: number;
}

// Messages arriving from the webview script.
interface WebviewMessage {
  type?: string;
  key?: string;
  text?: string;
  messageId?: string;
  id?: string;
  action?: string;
}

function nextId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Generates a random nonce for the strict Content-Security-Policy.
function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

// The Decoded sidebar: an error list, a chat transcript, and an input box.
// All rendering happens in the webview script from structured data — the
// extension never sends HTML strings.
export class DecodedChatViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly viewId = "decoded.chatView";

  private view: vscode.WebviewView | undefined;
  private transcript: TranscriptItem[] = [];
  private errors: ErrorItem[] = [];
  private busy = false;
  // Per-explanation data for the "Apply fix" button.
  private readonly fixes = new Map<
    string,
    { source: ExplainSource; corrected: string }
  >();

  // Events the extension wires to the explain/chat flows.
  private readonly explainEmitter = new vscode.EventEmitter<string>();
  readonly onExplainDiagnostic = this.explainEmitter.event;
  private readonly followUpEmitter = new vscode.EventEmitter<string>();
  readonly onFollowUp = this.followUpEmitter.event;
  private readonly newChatEmitter = new vscode.EventEmitter<void>();
  readonly onNewChat = this.newChatEmitter.event;
  private readonly loadHistoryEmitter = new vscode.EventEmitter<string>();
  readonly onLoadHistory = this.loadHistoryEmitter.event;
  private readonly visibleEmitter = new vscode.EventEmitter<void>();
  readonly onDidBecomeVisible = this.visibleEmitter.event;
  private readonly scanEmitter = new vscode.EventEmitter<void>();
  readonly onScanWorkspace = this.scanEmitter.event;
  private readonly promptActionEmitter = new vscode.EventEmitter<string>();
  readonly onPromptAction = this.promptActionEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly history: HistoryStore
  ) {
    // Keep the history drawer in sync.
    history.onDidChange(() => this.postHistory());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) =>
      this.handleMessage(msg)
    );
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.visibleEmitter.fire();
      }
    });
  }

  // Brings the view into focus (creating it if needed).
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(
      `${DecodedChatViewProvider.viewId}.focus`
    );
  }

  // --- Methods the explain/chat flows call to render output. ---

  addUserMessage(title: string): string {
    const id = nextId();
    this.push({ kind: "user", id, title });
    return id;
  }

  addExplanation(explanation: Explanation, source?: ExplainSource): string {
    const id = nextId();
    if (source) {
      this.fixes.set(id, {
        source,
        corrected: explanation.howToFix.correctedCode,
      });
    }
    this.push({ kind: "explanation", id, explanation, canApplyFix: !!source });
    return id;
  }

  addAssistantMarkdown(markdown: string): string {
    const id = nextId();
    this.push({ kind: "assistant", id, markdown });
    return id;
  }

  addErrorMessage(message: string): string {
    const id = nextId();
    this.push({ kind: "error", id, message });
    return id;
  }

  // A question card with action buttons (e.g. "Want me to fix the errors?").
  addPrompt(text: string, actions: PromptAction[]): string {
    const id = nextId();
    this.push({ kind: "prompt", id, text, actions });
    return id;
  }

  setBusy(busy: boolean, label?: string): void {
    this.busy = busy;
    this.post({ type: "busy", value: busy, label });
  }

  setErrors(items: ErrorItem[]): void {
    this.errors = items;
    this.post({ type: "errors", items });
  }

  // Clears the transcript (the "New Chat" command).
  clearTranscript(): void {
    this.transcript = [];
    this.fixes.clear();
    this.post({ type: "reset" });
  }

  // Re-sends provider/model after a settings change.
  postConfig(): void {
    this.post({ type: "config", ...this.configPayload() });
  }

  // --- Internals. ---

  private push(item: TranscriptItem): void {
    this.transcript.push(item);
    this.post({ type: "append", item });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private configPayload(): { provider: string; model: string } {
    const { provider, model } = getActiveProvider();
    return { provider: provider.label, model };
  }

  private historySummaries(): HistorySummary[] {
    return this.history.getAll().map((e) => ({
      id: e.id,
      title: e.title,
      language: e.language,
      timestamp: e.timestamp,
    }));
  }

  private postHistory(): void {
    this.post({ type: "history", items: this.historySummaries() });
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.post({
          type: "init",
          config: this.configPayload(),
          history: this.historySummaries(),
          errors: this.errors,
          transcript: this.transcript,
          busy: this.busy,
        });
        break;
      case "explainDiagnostic":
        if (typeof msg.key === "string" && !this.busy) {
          this.explainEmitter.fire(msg.key);
        }
        break;
      case "followUp":
        if (typeof msg.text === "string" && msg.text.trim() && !this.busy) {
          this.followUpEmitter.fire(msg.text.trim());
        }
        break;
      case "applyFix":
        if (typeof msg.messageId === "string") {
          const fix = this.fixes.get(msg.messageId);
          if (fix) {
            await applyFix(fix.source, fix.corrected);
          } else {
            vscode.window.showWarningMessage(
              "Decoded: No fix is available to apply."
            );
          }
        }
        break;
      case "newChat":
        this.newChatEmitter.fire();
        break;
      case "loadHistory":
        if (typeof msg.id === "string") {
          this.loadHistoryEmitter.fire(msg.id);
        }
        break;
      case "setApiKey":
        await vscode.commands.executeCommand("decoded.setApiKey");
        break;
      case "scanWorkspace":
        if (!this.busy) {
          this.scanEmitter.fire();
        }
        break;
      case "promptAction":
        if (typeof msg.action === "string" && !this.busy) {
          this.promptActionEmitter.fire(msg.action);
        }
        break;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "chat.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // Static shell only — the webview script renders everything inside it.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Decoded</title>
</head>
<body>
  <header class="decoded-topbar">
    <span id="provider-label" class="decoded-provider"></span>
    <button id="history-toggle" class="decoded-link" type="button">History</button>
  </header>
  <section id="history-drawer" class="decoded-drawer" hidden>
    <ul id="history-list"></ul>
  </section>
  <section id="errors-panel" class="decoded-errors">
    <div class="decoded-errors-bar">
      <button id="errors-toggle" class="decoded-errors-header" type="button">
        <span class="decoded-chevron">▾</span>
        Problems <span id="errors-count" class="decoded-count">0</span>
      </button>
      <button id="scan-btn" class="decoded-link" type="button" title="Read the whole workspace and look for errors">Scan</button>
    </div>
    <ul id="errors-list"></ul>
  </section>
  <main id="transcript" class="decoded-transcript"></main>
  <div id="busy" class="decoded-busy" hidden>
    <span class="decoded-spinner"></span><span id="busy-label">Thinking…</span>
  </div>
  <footer class="decoded-composer">
    <textarea id="input" rows="2" placeholder="Ask a follow-up question…"></textarea>
    <button id="send" type="button" title="Send">➤</button>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.explainEmitter.dispose();
    this.followUpEmitter.dispose();
    this.newChatEmitter.dispose();
    this.loadHistoryEmitter.dispose();
    this.visibleEmitter.dispose();
    this.scanEmitter.dispose();
    this.promptActionEmitter.dispose();
  }
}
