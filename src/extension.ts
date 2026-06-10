import * as vscode from "vscode";
import { runExplainError, type ExplainTarget } from "./explain";
import {
  setApiKeyCommand,
  clearApiKeyCommand,
  ensureApiKey,
  migrateLegacyApiKey,
} from "./secrets";
import { DecodedCodeActionProvider } from "./codeActions";
import { HistoryStore } from "./history";
import { DecodedChatViewProvider } from "./chatView";
import { ConversationManager } from "./conversation";
import { DiagnosticsWatcher } from "./diagnostics";
import { chat } from "./providers/explain";
import { PROVIDERS, getActiveProvider } from "./providers";
import { setActiveProviderId, setConfiguredModel } from "./config";
import { scanWorkspace } from "./scan";
import { fixAllErrors } from "./autofix";

// Chat messages that mean "look for errors" rather than a question for the AI.
const SCAN_INTENT =
  /\b(scan|find (the )?errors?|look for (any )?errors?|check (my |the )?(code|project|workspace|codebase)|read (my |the )?(code|project|workspace|codebase))\b/i;

// "Decoded: Select AI Provider" — pick a provider, then a model for it.
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
            ? " They're listed under Problems above — click one for a full lesson."
            : " Keep coding — I'll keep watching for new ones.")
      );
      if (errorCount > 0) {
        chatView.addPrompt("Want me to fix the errors for you?", [
          { label: "Yes, fix them", action: "fixAll" },
          { label: "Not now", action: "dismiss" },
        ]);
      }
    } finally {
      chatView.setBusy(false);
      scanning = false;
    }
  };

  // Auto-scan once per session, the first time the user opens the sidebar.
  let hasAutoScanned = false;
  chatView.onDidBecomeVisible(() => {
    watcher.refresh();
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

  // The "Yes, fix them" / "Not now" buttons on the ask-to-fix card.
  chatView.onPromptAction(async (action) => {
    if (action === "fixAll") {
      await fixAllErrors(context, chatView, watcher, history);
    } else if (action === "dismiss") {
      chatView.addAssistantMarkdown(
        "Okay — they stay listed under Problems. Click one any time for an explanation, or hit **Scan** to ask again."
      );
    }
  });

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
  chatView.onFollowUp(async (text) => {
    // "scan my code" / "look for errors" runs a scan instead of asking the AI.
    if (SCAN_INTENT.test(text)) {
      chatView.addUserMessage(text);
      await runScan();
      return;
    }
    const { provider, model } = getActiveProvider();
    const apiKey = await ensureApiKey(context, provider.id);
    if (!apiKey) {
      vscode.window.showWarningMessage(
        `Decoded: A ${provider.label} API key is required to chat.`
      );
      return;
    }
    chatView.addUserMessage(text);
    chatView.setBusy(true, "Decoded is thinking…");
    try {
      const answer = await chat(
        provider,
        { apiKey, model },
        conversation.buildHistory(),
        text
      );
      conversation.addExchange(text, answer);
      chatView.addAssistantMarkdown(answer);
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
    chatView,
    explain,
    setKey,
    clearKey,
    selectProvider,
    newChat,
    scanCommand,
    configListener,
    codeActions,
    clearHistory
  );
}

// Called when the extension is deactivated.
export function deactivate() {}
