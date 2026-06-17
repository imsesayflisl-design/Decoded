import * as vscode from "vscode";
import { runExplainError, type ExplainTarget } from "./explain";
import {
  setApiKeyCommand,
  clearApiKeyCommand,
  resolveOrPromptAuth,
  migrateLegacyApiKey,
} from "./secrets";
import { DecodedCodeActionProvider } from "./codeActions";
import { HistoryStore } from "./history";
import { DecodedChatViewProvider } from "./chatView";
import { ConversationManager } from "./conversation";
import { DiagnosticsWatcher } from "./diagnostics";
import { chat, ASK_SYSTEM_PROMPT } from "./providers/explain";
import { gatherAskContext, type FileRef } from "./codebaseContext";
import { PROVIDERS, getActiveProvider } from "./providers";
import {
  setActiveProviderId,
  setConfiguredModel,
  getTerminalAutoDetect,
} from "./config";
import { scanWorkspace } from "./scan";
import { runReviewFile } from "./review";
import { runDiagnose, diagnoseErrorText } from "./diagnose";
import { TerminalCaptureWatcher, type CapturedError } from "./terminalCapture";

// Chat messages that mean "look for errors" rather than a question for the AI.
const SCAN_INTENT =
  /\b(scan|find (the )?errors?|look for (any )?errors?|check (my |the )?(code|project|workspace|codebase)|read (my |the )?(code|project|workspace|codebase))\b/i;

// A context item attached with the + button. Only the reference is stored;
// the content is read fresh at send time so edits are always included.
type ContextRef =
  | { type: "file"; uri: vscode.Uri }
  | { type: "selection"; uri: vscode.Uri; range: vscode.Range }
  | { type: "diagnostic"; diagKey: string };

// Caps so a huge file can't blow up the prompt.
const MAX_CONTEXT_ITEM_CHARS = 12000;
const MAX_CONTEXT_TOTAL_CHARS = 24000;

// "Decoded: Choose AI Model" — pick a provider, then a model for it.
async function selectProviderCommand(): Promise<void> {
  const active = getActiveProvider();
  const pickedProvider = await vscode.window.showQuickPick(
    PROVIDERS.map((p) => ({
      label: p.label,
      description: p.id === active.provider.id ? "current" : undefined,
      id: p.id,
    })),
    { placeHolder: "Which AI provider should Decoded use?" }
  );
  if (!pickedProvider) {
    return;
  }
  const provider = PROVIDERS.find((p) => p.id === pickedProvider.id)!;
  const pickedModel = await vscode.window.showQuickPick(
    provider.models.map((m) => ({
      label: m,
      description: m === provider.defaultModel ? "default" : undefined,
    })),
    { placeHolder: `Which ${provider.label} model?` }
  );
  if (!pickedModel) {
    return;
  }
  await setActiveProviderId(provider.id);
  await setConfiguredModel(provider.id, pickedModel.label);
  vscode.window.showInformationMessage(
    `Decoded: Using ${provider.label} · ${pickedModel.label}.`
  );
}

// Called once when the extension is activated.
export function activate(context: vscode.ExtensionContext) {
  const history = new HistoryStore(context);
  const conversation = new ConversationManager();
  const chatView = new DecodedChatViewProvider(context.extensionUri, history);
  const watcher = new DiagnosticsWatcher();
  const terminalCapture = new TerminalCaptureWatcher();

  // Move any pre-multi-provider Anthropic key to its new slot (fire and forget).
  void migrateLegacyApiKey(context);

  // The sidebar chat view (the activity-bar icon opens this).
  const view = vscode.window.registerWebviewViewProvider(
    DecodedChatViewProvider.viewId,
    chatView,
    { webviewOptions: { retainContextWhenHidden: true } }
  );

  // Auto-detected problems feed the sidebar list; the AI runs only on click.
  watcher.onDidChangeErrors((items) => chatView.setErrors(items));

  // --- Auto-captured terminal errors (explain-on-click only). ---

  // id -> the captured command output, kept until the user clicks Explain.
  const capturedErrors = new Map<string, CapturedError>();
  // How many captured errors the user hasn't looked at yet (drives the badge).
  let unexplainedCount = 0;

  // A command failed in the terminal: show a quiet card + badge. We never call
  // the AI here — only when the user clicks Explain on the card.
  terminalCapture.onDidCaptureError((capture) => {
    if (!getTerminalAutoDetect()) {
      return; // auto-detect turned off in settings
    }
    const id = chatView.addCapturedError(capture);
    capturedErrors.set(id, capture);
    unexplainedCount++;
    chatView.setBadge(unexplainedCount);
  });

  // The "Explain this error" button on a captured-error card.
  chatView.onExplainCapture(async (id) => {
    const capture = capturedErrors.get(id);
    if (!capture) {
      return; // already handled or lost (e.g. after New Chat)
    }
    const title =
      capture.command.trim() ||
      capture.output.split("\n")[0]?.trim() ||
      "A terminal command failed";
    const rendered = await diagnoseErrorText(
      context,
      chatView,
      capture.output,
      title
    );
    if (rendered) {
      capturedErrors.delete(id);
      chatView.markCaptureExplained(id);
      unexplainedCount = Math.max(0, unexplainedCount - 1);
      chatView.setBadge(unexplainedCount);
    }
  });

  // --- Context attachments (the + button in the composer). ---

  const pendingContext = new Map<string, ContextRef>();
  let contextCounter = 0;

  // The + button: pick the active file, the selection, or a listed error.
  chatView.onPickContext(async () => {
    type PickItem = vscode.QuickPickItem & {
      ref?: ContextRef;
      chipType?: "file" | "selection" | "diagnostic";
      chipLabel?: string;
      chipDetail?: string;
    };
    const items: PickItem[] = [];
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const base = rel.split(/[\\/]/).pop() ?? rel;
      items.push({
        label: `$(file) Active file — ${base}`,
        description: rel,
        ref: { type: "file", uri: editor.document.uri },
        chipType: "file",
        chipLabel: base,
        chipDetail: rel,
      });
      if (!editor.selection.isEmpty) {
        const from = editor.selection.start.line + 1;
        const to = editor.selection.end.line + 1;
        items.push({
          label: `$(selection) Selection — ${base}:${from}-${to}`,
          description: rel,
          ref: {
            type: "selection",
            uri: editor.document.uri,
            range: new vscode.Range(editor.selection.start, editor.selection.end),
          },
          chipType: "selection",
          chipLabel: `${base}:${from}-${to}`,
          chipDetail: `Selected lines ${from}-${to} of ${rel}`,
        });
      }
    }
    for (const err of watcher.current().slice(0, 10)) {
      items.push({
        label: `$(error) ${err.message}`,
        description: `${err.file}:${err.line}`,
        ref: { type: "diagnostic", diagKey: err.key },
        chipType: "diagnostic",
        chipLabel: `${err.file}:${err.line}`,
        chipDetail: err.message,
      });
    }
    // Always offer a workspace file/folder picker for codebase questions.
    const BROWSE = "__browse__";
    items.push({
      label: "$(search) Add a workspace file…",
      description: "Pick any file to attach as context",
      chipType: "file",
    });
    items[items.length - 1].ref = undefined;
    (items[items.length - 1] as PickItem & { browse?: string }).browse = BROWSE;

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Attach context to your next message",
    });
    if (!picked) {
      return;
    }

    let ref = picked.ref;
    let chipType = picked.chipType;
    let chipLabel = picked.chipLabel;
    let chipDetail = picked.chipDetail;

    // The browse option opens a workspace file Quick Pick.
    if ((picked as PickItem & { browse?: string }).browse === BROWSE) {
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,out,build,.next,coverage}/**",
        2000
      );
      const fileItems = uris
        .map((u) => ({
          label: `$(file) ${vscode.workspace.asRelativePath(u).split(/[\\/]/).pop()}`,
          description: vscode.workspace.asRelativePath(u),
          uri: u,
        }))
        .sort((a, b) => a.description.localeCompare(b.description));
      const file = await vscode.window.showQuickPick(fileItems, {
        placeHolder: "Pick a file to attach",
        matchOnDescription: true,
      });
      if (!file) {
        return;
      }
      const base = file.description.split(/[\\/]/).pop() ?? file.description;
      ref = { type: "file", uri: file.uri };
      chipType = "file";
      chipLabel = base;
      chipDetail = file.description;
    }

    if (!ref) {
      return;
    }
    const id = `ctx-${Date.now()}-${contextCounter++}`;
    pendingContext.set(id, ref);
    chatView.addContextChip({
      id,
      type: chipType!,
      label: chipLabel!,
      detail: chipDetail!,
    });
  });

  chatView.onRemoveContext((id) => {
    pendingContext.delete(id);
  });

  // Turns attached chips into CONTEXT blocks for the model, reading the
  // files at send time so the content is always current. Also reports which
  // file URIs were used (so codebase retrieval can avoid re-reading them) and
  // the files read (for the transparency footer).
  const resolveContextBlocks = async (
    ids: string[]
  ): Promise<{ blocks: string; uris: Set<string>; filesRead: FileRef[] }> => {
    const blocks: string[] = [];
    const uris = new Set<string>();
    const filesRead: FileRef[] = [];
    let total = 0;
    for (const id of ids) {
      const ref = pendingContext.get(id);
      if (!ref) {
        continue;
      }
      let label = "";
      let content = "";
      try {
        if (ref.type === "file") {
          const doc = await vscode.workspace.openTextDocument(ref.uri);
          label = vscode.workspace.asRelativePath(ref.uri);
          content = doc.getText();
        } else if (ref.type === "selection") {
          const doc = await vscode.workspace.openTextDocument(ref.uri);
          const range = doc.validateRange(ref.range);
          label = `${vscode.workspace.asRelativePath(ref.uri)}:${range.start.line + 1}-${range.end.line + 1}`;
          content = doc.getText(range);
        } else {
          const resolved = watcher.resolve(ref.diagKey);
          if (!resolved) {
            continue; // the error was fixed since it was attached
          }
          const doc = await vscode.workspace.openTextDocument(resolved.uri);
          const line = resolved.diagnostic.range.start.line;
          const from = Math.max(0, line - 10);
          const to = Math.min(doc.lineCount - 1, line + 10);
          const snippet = doc.getText(
            new vscode.Range(from, 0, to, doc.lineAt(to).text.length)
          );
          label = `${vscode.workspace.asRelativePath(resolved.uri)}:${line + 1}`;
          content = `Error: ${resolved.diagnostic.message}\n\n${snippet}`;
        }
      } catch {
        continue; // file deleted or unreadable — skip this chip
      }
      if (!content.trim()) {
        continue;
      }
      if (content.length > MAX_CONTEXT_ITEM_CHARS) {
        content = content.slice(0, MAX_CONTEXT_ITEM_CHARS) + "\n…[truncated]";
      }
      if (total + content.length > MAX_CONTEXT_TOTAL_CHARS) {
        break;
      }
      total += content.length;
      blocks.push(`CONTEXT — ${label}:\n\`\`\`\n${content}\n\`\`\``);
      if (ref.type === "file") {
        uris.add(ref.uri.toString());
      } else if (ref.type === "selection") {
        uris.add(ref.uri.toString());
      }
      filesRead.push({ label, uri: label });
    }
    return { blocks: blocks.join("\n\n"), uris, filesRead };
  };

  // Reads the workspace (no AI calls), reports what it found, and asks for
  // permission before fixing anything.
  let scanning = false;
  const runScan = async () => {
    if (scanning) {
      return;
    }
    scanning = true;
    await chatView.focus();
    chatView.setBusy(true, "Decoded is reading your codebase…");
    try {
      const opened = await scanWorkspace();
      const errors = watcher.current();
      const errorCount = errors.filter((e) => e.severity === "error").length;
      const warningCount = errors.length - errorCount;
      const found =
        errorCount === 0
          ? warningCount > 0
            ? `no errors (${warningCount} warning${warningCount === 1 ? "" : "s"})`
            : "no problems"
          : `${errorCount} error${errorCount === 1 ? "" : "s"}` +
            (warningCount > 0 ? ` and ${warningCount} warning${warningCount === 1 ? "" : "s"}` : "");
      chatView.addAssistantMarkdown(
        `I read **${opened} files** in your workspace and found **${found}**.` +
          (errorCount > 0
            ? " They're listed under Problems above — click any one and I'll explain what's wrong and how to fix it yourself."
            : " Keep coding — I'll keep watching for new ones.")
      );
    } finally {
      chatView.setBusy(false);
      scanning = false;
    }
  };

  // Auto-scan once per session, the first time the user opens the sidebar.
  let hasAutoScanned = false;
  chatView.onDidBecomeVisible(() => {
    watcher.refresh();
    // The user is now looking at the sidebar, so clear the "unseen" badge.
    // The captured-error cards stay in the transcript, still explainable.
    if (unexplainedCount > 0) {
      unexplainedCount = 0;
      chatView.setBadge(0);
    }
    if (!hasAutoScanned) {
      hasAutoScanned = true;
      void runScan();
    }
  });

  chatView.onScanWorkspace(() => void runScan());
  const scanCommand = vscode.commands.registerCommand(
    "decoded.scanWorkspace",
    () => runScan()
  );

  // A click on a listed problem explains exactly that diagnostic.
  chatView.onExplainDiagnostic(async (key) => {
    const resolved = watcher.resolve(key);
    if (!resolved) {
      vscode.window.showInformationMessage(
        "Decoded: That problem has changed or been fixed. The list will refresh."
      );
      watcher.refresh();
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(resolved.uri);
      await runExplainError(context, history, chatView, conversation, {
        document,
        diagnostic: resolved.diagnostic,
      });
    } catch {
      vscode.window.showWarningMessage(
        "Decoded: Couldn't open that file — it may have been deleted."
      );
      watcher.refresh();
    }
  });

  // Follow-up questions typed into the chat input.
  chatView.onFollowUp(async ({ text, contextIds }) => {
    // "/model" opens the provider + model picker right from the chat.
    if (/^\/(model|provider|ai)\b/i.test(text.trim())) {
      chatView.addUserMessage(text);
      await selectProviderCommand();
      chatView.postConfig();
      const { provider, model } = getActiveProvider();
      chatView.addAssistantMarkdown(
        `You're using **${provider.label} · ${model}**. Type \`/model\` or use the picker in the input box any time to switch.`
      );
      return;
    }
    // "scan my code" / "look for errors" runs a scan instead of asking the AI.
    if (SCAN_INTENT.test(text)) {
      chatView.addUserMessage(text);
      await runScan();
      return;
    }
    const { provider, model } = getActiveProvider();
    const auth = await resolveOrPromptAuth(context, provider.id);
    if (!auth) {
      vscode.window.showWarningMessage(
        `Decoded: A ${provider.label} API key is required to chat.`
      );
      return;
    }
    chatView.addUserMessage(text);
    chatView.setBusy(true, "Decoded is reading your code…");
    try {
      // 1) Explicit context the user attached with the + button.
      const attached = await resolveContextBlocks(contextIds);
      for (const id of contextIds) {
        pendingContext.delete(id);
      }
      // 2) Codebase awareness: active file/selection, @-mentions, and
      // lightweight retrieval — skipping anything already attached above.
      const auto = await gatherAskContext(text, attached.uris);

      const allBlocks = [attached.blocks, auto.blocks]
        .filter((b) => b)
        .join("\n\n");
      const modelText = allBlocks
        ? `${allBlocks}\n\nQUESTION:\n${text}`
        : text;

      // Stream the reply into the transcript as it's generated, updating at
      // most every 100ms so the webview isn't flooded.
      let streamId: string | undefined;
      let streamed = "";
      let lastUpdate = 0;
      const answer = await chat(
        provider,
        { apiKey: auth.apiKey, model, baseURL: auth.baseURL },
        conversation.buildHistory(),
        modelText,
        (delta) => {
          streamed += delta;
          streamId ??= chatView.beginAssistantStream();
          const now = Date.now();
          if (now - lastUpdate >= 100) {
            lastUpdate = now;
            chatView.updateAssistantStream(streamId, streamed);
          }
        },
        ASK_SYSTEM_PROMPT
      );
      conversation.addExchange(text, answer);
      if (streamId) {
        chatView.updateAssistantStream(streamId, answer);
      } else {
        // Provider didn't stream (or produced everything at once).
        chatView.addAssistantMarkdown(answer);
      }

      // Be transparent about which files Decoded read to answer.
      const read = [...attached.filesRead, ...auto.filesRead];
      if (read.length > 0) {
        const list = read.map((f) => `\`${f.label}\``).join(", ");
        const note = auto.truncated
          ? " _(some files were large, so I read the most relevant parts)_"
          : "";
        chatView.addAssistantMarkdown(`📎 Read to answer: ${list}${note}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      chatView.addErrorMessage(message);
    } finally {
      chatView.setBusy(false);
    }
  });

  // Reopen a past explanation in the chat (no Apply fix — the code may have
  // changed since it was saved).
  chatView.onLoadHistory((id) => {
    const entry = history.get(id);
    if (entry) {
      chatView.addUserMessage(entry.title);
      chatView.addExplanation(entry.result);
      conversation.startSessionFromHistory(entry.title, entry.result);
    }
  });

  // "New Chat" from the webview header button or the command.
  const startNewChat = () => {
    conversation.reset();
    chatView.clearTranscript();
    pendingContext.clear();
    // The captured-error cards are gone with the transcript; drop their data
    // and clear the badge so nothing dangles.
    capturedErrors.clear();
    unexplainedCount = 0;
    chatView.setBadge(0);
  };
  chatView.onNewChat(startNewChat);
  const newChat = vscode.commands.registerCommand(
    "decoded.newChat",
    startNewChat
  );

  // The core command: explain the error at the cursor/selection (or an
  // explicit diagnostic passed by the lightbulb).
  const explain = vscode.commands.registerCommand(
    "decoded.explainError",
    (target?: ExplainTarget) =>
      runExplainError(context, history, chatView, conversation, target)
  );

  // "Ask Decoded": focus the chat view so the user can ask anything.
  const ask = vscode.commands.registerCommand("decoded.ask", async () => {
    await chatView.focus();
  });

  // Whole-file review: every issue, what's missing, how to fix.
  const reviewFile = vscode.commands.registerCommand("decoded.reviewFile", () =>
    runReviewFile(context, chatView)
  );

  // Diagnose run/setup errors (e.g. missing node_modules) from the terminal.
  const diagnose = vscode.commands.registerCommand(
    "decoded.diagnoseError",
    () => runDiagnose(context, chatView)
  );

  // Key + provider management.
  const setKey = vscode.commands.registerCommand("decoded.setApiKey", () =>
    setApiKeyCommand(context)
  );
  const clearKey = vscode.commands.registerCommand("decoded.clearApiKey", () =>
    clearApiKeyCommand(context)
  );
  const selectProvider = vscode.commands.registerCommand(
    "decoded.selectProvider",
    async () => {
      await selectProviderCommand();
      chatView.postConfig();
    }
  );

  // Keep the provider/model label in the chat header current.
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("decoded")) {
      chatView.postConfig();
      watcher.refresh();
    }
  });

  // Lightbulb / quick-fix on diagnostics, for every language.
  const codeActions = vscode.languages.registerCodeActionsProvider(
    "*",
    new DecodedCodeActionProvider(),
    { providedCodeActionKinds: DecodedCodeActionProvider.providedKinds }
  );

  // Clear the history (with confirmation).
  const clearHistory = vscode.commands.registerCommand(
    "decoded.clearHistory",
    async () => {
      const choice = await vscode.window.showWarningMessage(
        "Decoded: Clear all saved explanations?",
        { modal: true },
        "Clear"
      );
      if (choice === "Clear") {
        await history.clear();
      }
    }
  );

  context.subscriptions.push(
    view,
    watcher,
    terminalCapture,
    chatView,
    explain,
    setKey,
    clearKey,
    selectProvider,
    ask,
    reviewFile,
    diagnose,
    newChat,
    scanCommand,
    configListener,
    codeActions,
    clearHistory
  );
}

// Called when the extension is deactivated.
export function deactivate() {}
