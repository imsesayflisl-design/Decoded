import * as vscode from "vscode";
import type { Explanation, ReviewIssue, Diagnosis } from "./schema";
import type { HistoryStore } from "./history";
import type { ErrorItem } from "./diagnostics";
import { getActiveProvider, PROVIDERS } from "./providers";
import { setActiveProviderId, setConfiguredModel } from "./config";
import type { ProviderId } from "./providers/types";

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
    }
  | { kind: "assistant"; id: string; markdown: string }
  | { kind: "error"; id: string; message: string }
  | { kind: "prompt"; id: string; text: string; actions: PromptAction[] }
  | {
      kind: "review";
      id: string;
      summary: string;
      issues: ReviewIssue[];
      // The reviewed file's URI string + languageId (for jump-to-line + highlighting).
      file: string;
      language: string;
    }
  | { kind: "diagnosis"; id: string; diagnosis: Diagnosis }
  // A failed terminal command Decoded captured automatically. Nothing is sent
  // to the AI until the user clicks Explain (`explained` flips the button off).
  | {
      kind: "captured";
      id: string;
      command: string;
      output: string;
      exitCode: number;
      explained: boolean;
    };

interface HistorySummary {
  id: string;
  title: string;
  language: string;
  timestamp: number;
}

// A piece of context the user attached with the + button. The webview only
// holds these labels — the actual file content is resolved extension-side at
// send time.
export interface ContextChip {
  id: string;
  type: "file" | "selection" | "diagnostic";
  label: string;
  detail: string;
}

// Messages arriving from the webview script.
interface WebviewMessage {
  type?: string;
  key?: string;
  text?: string;
  messageId?: string;
  id?: string;
  action?: string;
  providerId?: string;
  model?: string;
  contextIds?: unknown;
  file?: string;
  line?: number;
  command?: string;
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

  // Events the extension wires to the explain/chat flows.
  private readonly explainEmitter = new vscode.EventEmitter<string>();
  readonly onExplainDiagnostic = this.explainEmitter.event;
  // Fired when the user clicks Explain on an auto-captured terminal error.
  private readonly explainCaptureEmitter = new vscode.EventEmitter<string>();
  readonly onExplainCapture = this.explainCaptureEmitter.event;
  private readonly followUpEmitter = new vscode.EventEmitter<{
    text: string;
    contextIds: string[];
  }>();
  readonly onFollowUp = this.followUpEmitter.event;
  private readonly pickContextEmitter = new vscode.EventEmitter<void>();
  readonly onPickContext = this.pickContextEmitter.event;
  private readonly removeContextEmitter = new vscode.EventEmitter<string>();
  readonly onRemoveContext = this.removeContextEmitter.event;
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

  addExplanation(explanation: Explanation): string {
    const id = nextId();
    this.push({ kind: "explanation", id, explanation });
    return id;
  }

  // Renders a quiet card for a terminal command Decoded saw fail. No AI call —
  // the card carries an Explain button that fires onExplainCapture when clicked.
  addCapturedError(capture: {
    command: string;
    output: string;
    exitCode: number;
  }): string {
    const id = nextId();
    this.push({
      kind: "captured",
      id,
      command: capture.command,
      output: capture.output,
      exitCode: capture.exitCode,
      explained: false,
    });
    return id;
  }

  // Marks a captured-error card as explained so its Explain button disables.
  markCaptureExplained(id: string): void {
    const item = this.transcript.find((t) => t.id === id);
    if (item && item.kind === "captured") {
      item.explained = true;
    }
    this.post({ type: "captureExplained", id });
  }

  addAssistantMarkdown(markdown: string): string {
    const id = nextId();
    this.push({ kind: "assistant", id, markdown });
    return id;
  }

  // Streaming: opens an (empty) assistant message that updateAssistantStream
  // grows as text arrives from the model.
  beginAssistantStream(): string {
    return this.addAssistantMarkdown("");
  }

  updateAssistantStream(id: string, markdown: string): void {
    const item = this.transcript.find((t) => t.id === id);
    if (item && item.kind === "assistant") {
      item.markdown = markdown;
    }
    this.post({ type: "updateAssistant", id, markdown });
  }

  addErrorMessage(message: string): string {
    const id = nextId();
    this.push({ kind: "error", id, message });
    return id;
  }

  // "Review File" result — a summary + list of issue cards.
  addReview(
    summary: string,
    issues: ReviewIssue[],
    file: string,
    language: string
  ): string {
    const id = nextId();
    this.push({ kind: "review", id, summary, issues, file, language });
    return id;
  }

  // "Diagnose" result — a setup-error fix card with a copyable command.
  addDiagnosis(diagnosis: Diagnosis): string {
    const id = nextId();
    this.push({ kind: "diagnosis", id, diagnosis });
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
    this.post({ type: "reset" });
  }

  // Re-sends provider/model after a settings change.
  postConfig(): void {
    this.post({ type: "config", ...this.configPayload() });
  }

  // Shows a context pill above the input (result of the + button picker).
  addContextChip(chip: ContextChip): void {
    this.post({ type: "contextChip", chip });
  }

  // Puts a count badge on the Decoded activity-bar icon (used to flag captured
  // terminal errors waiting to be explained), or clears it when count is 0.
  setBadge(count: number): void {
    if (!this.view) {
      return;
    }
    this.view.badge =
      count > 0
        ? {
            value: count,
            tooltip:
              count === 1
                ? "Decoded noticed a command that failed"
                : `Decoded noticed ${count} commands that failed`,
          }
        : undefined;
  }

  // --- Internals. ---

  private push(item: TranscriptItem): void {
    this.transcript.push(item);
    this.post({ type: "append", item });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  // Current provider/model plus the full catalog so the webview can render
  // its own model picker (like Copilot's dropdown in the input box).
  private configPayload(): {
    providerId: string;
    provider: string;
    model: string;
    providers: {
      id: string;
      label: string;
      models: string[];
      defaultModel: string;
    }[];
  } {
    const { provider, model } = getActiveProvider();
    return {
      providerId: provider.id,
      provider: provider.label,
      model,
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        models: p.models,
        defaultModel: p.defaultModel,
      })),
    };
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
          const contextIds = Array.isArray(msg.contextIds)
            ? msg.contextIds.filter((x): x is string => typeof x === "string")
            : [];
          this.followUpEmitter.fire({ text: msg.text.trim(), contextIds });
        }
        break;
      case "selectModel": {
        // The in-webview model picker; validate against the real catalog.
        const provider = PROVIDERS.find((p) => p.id === msg.providerId);
        if (
          provider &&
          typeof msg.model === "string" &&
          provider.models.includes(msg.model)
        ) {
          await setActiveProviderId(provider.id as ProviderId);
          await setConfiguredModel(provider.id as ProviderId, msg.model);
          // The settings-change listener in extension.ts broadcasts the new
          // config back to the webview.
        }
        break;
      }
      case "pickContext":
        if (!this.busy) {
          this.pickContextEmitter.fire();
        }
        break;
      case "removeContext":
        if (typeof msg.id === "string") {
          this.removeContextEmitter.fire(msg.id);
        }
        break;
      case "explainCapture":
        if (typeof msg.id === "string" && !this.busy) {
          this.explainCaptureEmitter.fire(msg.id);
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
      case "openLocation":
        if (typeof msg.file === "string" && typeof msg.line === "number") {
          await this.openLocation(msg.file, msg.line);
        }
        break;
      case "copyCommand":
        if (typeof msg.command === "string" && msg.command.trim()) {
          await vscode.env.clipboard.writeText(msg.command);
          vscode.window.showInformationMessage(
            "Decoded: Command copied to clipboard."
          );
        }
        break;
    }
  }

  // Jumps to a line in a file (clicked from a Review issue card).
  private async openLocation(file: string, line: number): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(file)
      );
      const editor = await vscode.window.showTextDocument(document);
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
    } catch {
      vscode.window.showWarningMessage(
        "Decoded: Couldn't open that location — the file may have changed."
      );
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
    <span class="decoded-busy-icon">✦</span><span id="busy-label">Thinking…</span>
  </div>
  <footer class="decoded-composer">
    <div id="context-chips" class="decoded-chips" hidden></div>
    <textarea id="input" rows="2" placeholder="Ask Decoded…"></textarea>
    <div class="decoded-composer-bar">
      <button id="add-context" class="decoded-icon-btn" type="button" title="Add context (file, selection, or error)">+</button>
      <button id="model-btn" class="decoded-model-btn" type="button" title="Change AI model">
        <span id="model-btn-label"></span><span class="decoded-caret">▾</span>
      </button>
      <span class="decoded-bar-spacer"></span>
      <button id="send" class="decoded-icon-btn decoded-send" type="button" title="Send">➤</button>
    </div>
    <div id="model-menu" class="decoded-model-menu" hidden></div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.explainEmitter.dispose();
    this.explainCaptureEmitter.dispose();
    this.followUpEmitter.dispose();
    this.pickContextEmitter.dispose();
    this.removeContextEmitter.dispose();
    this.newChatEmitter.dispose();
    this.loadHistoryEmitter.dispose();
    this.visibleEmitter.dispose();
    this.scanEmitter.dispose();
    this.promptActionEmitter.dispose();
  }
}
