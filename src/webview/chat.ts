// Webview-side script for the Decoded chat sidebar. Bundled to
// dist/webview.js (browser IIFE). Renders everything from structured data
// posted by the extension — all escaping happens here, in one place.
import hljs from "highlight.js/lib/common";

// Provided by VS Code inside webviews.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();

// --- Types mirrored from the extension side (keep in sync). ---

interface Explanation {
  language: string;
  whatItMeans: { explanation: string; relevantCode: string };
  whyItsHappening: string;
  howToFix: { steps: string[]; brokenCode: string; correctedCode: string };
  howToAvoidNextTime: string;
}

interface PromptAction {
  label: string;
  action: string;
}

type TranscriptItem =
  | { kind: "user"; id: string; title: string }
  | { kind: "explanation"; id: string; explanation: Explanation; canApplyFix: boolean }
  | { kind: "assistant"; id: string; markdown: string }
  | { kind: "error"; id: string; message: string }
  | { kind: "prompt"; id: string; text: string; actions: PromptAction[] };

interface ErrorItem {
  key: string;
  message: string;
  file: string;
  line: number;
  severity: "error" | "warning";
}

interface HistorySummary {
  id: string;
  title: string;
  language: string;
  timestamp: number;
}

// One provider and its models, sent by the extension so the model picker in
// the composer can list everything without hardcoding.
interface ProviderInfo {
  id: string;
  label: string;
  models: string[];
  defaultModel: string;
}

// A context pill above the input (the + button). Only labels live here; the
// extension resolves the real file content when the message is sent.
interface Chip {
  id: string;
  type: string;
  label: string;
  detail: string;
}

// --- DOM helpers. ---

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// Maps a VS Code languageId to a highlight.js language class.
const HLJS_LANGS: Record<string, string> = {
  typescript: "typescript",
  typescriptreact: "typescript",
  javascript: "javascript",
  javascriptreact: "javascript",
  python: "python",
  java: "java",
  csharp: "csharp",
  cpp: "cpp",
  c: "c",
  go: "go",
  rust: "rust",
  ruby: "ruby",
  php: "php",
  json: "json",
  html: "xml",
  css: "css",
  shellscript: "bash",
  sql: "sql",
  yaml: "yaml",
};

function codeBlock(code: string, languageId?: string): HTMLElement {
  const pre = el("pre");
  const codeEl = el("code");
  const lang = languageId ? HLJS_LANGS[languageId] ?? languageId : undefined;
  if (lang) {
    codeEl.className = `language-${lang}`;
  }
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  hljs.highlightElement(codeEl);
  return pre;
}

// Minimal markdown for follow-up answers: fenced code blocks, inline code,
// bold, and paragraphs. Everything else is rendered as plain text.
function renderMarkdown(markdown: string): HTMLElement {
  const container = el("div", "decoded-markdown");
  const parts = markdown.split(/```(\w*)\n?/);
  // parts alternates: text, langTag, codeBody, text, langTag, codeBody, ...
  for (let i = 0; i < parts.length; i += 3) {
    renderProse(container, parts[i]);
    if (i + 2 < parts.length) {
      container.appendChild(codeBlock(parts[i + 2], parts[i + 1] || undefined));
    }
  }
  return container;
}

function renderProse(container: HTMLElement, text: string): void {
  for (const para of text.split(/\n{2,}/)) {
    if (!para.trim()) {
      continue;
    }
    const p = el("p");
    // Inline code and bold; built with DOM nodes, never innerHTML.
    const tokens = para.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/);
    for (const token of tokens) {
      if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
        p.appendChild(el("code", "decoded-inline-code", token.slice(1, -1)));
      } else if (token.startsWith("**") && token.endsWith("**")) {
        p.appendChild(el("strong", undefined, token.slice(2, -2)));
      } else if (token) {
        p.appendChild(document.createTextNode(token));
      }
    }
    container.appendChild(p);
  }
}

// --- Transcript rendering. ---

const transcript = byId<HTMLElement>("transcript");

// Copilot-style welcome screen: icon, title, and suggestion buttons that
// send a message when clicked.
const SUGGESTIONS = [
  "Scan my code for errors",
  "What can Decoded help me with?",
  "How do I read error messages?",
];

function renderEmptyState(): void {
  const empty = el("div", "decoded-empty");
  empty.appendChild(el("div", "decoded-welcome-icon", "✦"));
  empty.appendChild(el("h2", undefined, "Decoded"));
  empty.appendChild(
    el(
      "p",
      undefined,
      "I explain your errors and teach you while you code. Click a problem above, or start with one of these:"
    )
  );
  const suggestions = el("div", "decoded-suggestions");
  for (const text of SUGGESTIONS) {
    const btn = el("button", "decoded-suggestion", text);
    btn.type = "button";
    btn.addEventListener("click", () =>
      vscode.postMessage({ type: "followUp", text, contextIds: [] })
    );
    suggestions.appendChild(btn);
  }
  empty.appendChild(suggestions);
  transcript.appendChild(empty);
}

function clearEmptyState(): void {
  transcript.querySelector(".decoded-empty")?.remove();
}

function section(
  num: string,
  title: string
): { wrap: HTMLElement; body: HTMLElement } {
  const wrap = el("section", "decoded-part");
  const h = el("h3");
  h.appendChild(el("span", "decoded-step-number", num));
  h.appendChild(document.createTextNode(` ${title}`));
  wrap.appendChild(h);
  return { wrap, body: wrap };
}

function renderExplanation(item: {
  id: string;
  explanation: Explanation;
  canApplyFix: boolean;
}): HTMLElement {
  const card = el("article", "decoded-card");
  const e = item.explanation;

  const header = el("div", "decoded-card-header");
  header.appendChild(el("span", "decoded-lang", e.language));
  card.appendChild(header);

  const s1 = section("1", "What it means");
  s1.body.appendChild(el("p", "decoded-prose", e.whatItMeans.explanation));
  s1.body.appendChild(codeBlock(e.whatItMeans.relevantCode, e.language));
  card.appendChild(s1.wrap);

  const s2 = section("2", "Why it's happening");
  s2.body.appendChild(el("p", "decoded-prose", e.whyItsHappening));
  card.appendChild(s2.wrap);

  const s3 = section("3", "How to fix it");
  const ol = el("ol", "decoded-steps");
  for (const step of e.howToFix.steps) {
    ol.appendChild(el("li", undefined, step));
  }
  s3.body.appendChild(ol);
  const fix = el("div", "decoded-fix");
  const before = el("div", "decoded-before");
  before.appendChild(el("div", "decoded-code-label", "Before"));
  before.appendChild(codeBlock(e.howToFix.brokenCode, e.language));
  const after = el("div", "decoded-after");
  after.appendChild(el("div", "decoded-code-label", "After"));
  after.appendChild(codeBlock(e.howToFix.correctedCode, e.language));
  fix.appendChild(before);
  fix.appendChild(after);
  s3.body.appendChild(fix);
  if (item.canApplyFix) {
    const btn = el("button", "decoded-apply-fix", "Apply fix");
    btn.type = "button";
    btn.addEventListener("click", () =>
      vscode.postMessage({ type: "applyFix", messageId: item.id })
    );
    s3.body.appendChild(btn);
  }
  card.appendChild(s3.wrap);

  const s4 = section("4", "How to avoid it next time");
  s4.body.appendChild(el("p", "decoded-prose", e.howToAvoidNextTime));
  card.appendChild(s4.wrap);

  return card;
}

// A question card with action buttons; all buttons disable after one click.
function renderPrompt(item: {
  id: string;
  text: string;
  actions: PromptAction[];
}): HTMLElement {
  const card = el("div", "decoded-msg decoded-msg-assistant decoded-prompt");
  card.appendChild(el("p", "decoded-prose", item.text));
  const row = el("div", "decoded-prompt-actions");
  const buttons: HTMLButtonElement[] = [];
  for (const action of item.actions) {
    const btn = el("button", "decoded-apply-fix", action.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      buttons.forEach((b) => (b.disabled = true));
      vscode.postMessage({ type: "promptAction", action: action.action });
    });
    buttons.push(btn);
    row.appendChild(btn);
  }
  card.appendChild(row);
  return card;
}

// Wraps an AI response with a small "✦ Provider" header row, Copilot-style.
function assistantRow(node: HTMLElement): HTMLElement {
  const wrap = el("div", "decoded-assistant-row");
  const header = el("div", "decoded-msg-header");
  header.appendChild(el("span", "decoded-msg-icon", "✦"));
  header.appendChild(el("span", undefined, activeProviderLabel || "Decoded"));
  wrap.appendChild(header);
  wrap.appendChild(node);
  return wrap;
}

function renderItem(item: TranscriptItem): void {
  clearEmptyState();
  let node: HTMLElement;
  switch (item.kind) {
    case "user":
      node = el("div", "decoded-msg decoded-msg-user", item.title);
      break;
    case "explanation":
      node = assistantRow(renderExplanation(item));
      break;
    case "assistant": {
      const body = el("div", "decoded-msg decoded-msg-assistant");
      body.appendChild(renderMarkdown(item.markdown));
      node = assistantRow(body);
      break;
    }
    case "error":
      node = el("div", "decoded-msg decoded-msg-error", item.message);
      break;
    case "prompt":
      node = assistantRow(renderPrompt(item));
      break;
  }
  transcript.appendChild(node);
  node.scrollIntoView({ block: "end" });
}

// --- Error list. ---

const errorsList = byId<HTMLElement>("errors-list");
const errorsCount = byId<HTMLElement>("errors-count");
const errorsToggle = byId<HTMLButtonElement>("errors-toggle");
let errorsCollapsed = false;

errorsToggle.addEventListener("click", () => {
  errorsCollapsed = !errorsCollapsed;
  errorsList.hidden = errorsCollapsed;
  errorsToggle.querySelector(".decoded-chevron")!.textContent = errorsCollapsed
    ? "▸"
    : "▾";
});

byId<HTMLButtonElement>("scan-btn").addEventListener("click", () =>
  vscode.postMessage({ type: "scanWorkspace" })
);

function renderErrors(items: ErrorItem[]): void {
  errorsCount.textContent = String(items.length);
  errorsList.replaceChildren();
  if (items.length === 0) {
    errorsList.appendChild(
      el("li", "decoded-no-errors", "No problems detected — nice and clean.")
    );
    return;
  }
  for (const item of items) {
    const li = el("li", `decoded-error-item decoded-sev-${item.severity}`);
    const btn = el("button", "decoded-error-btn");
    btn.type = "button";
    btn.title = "Explain with Decoded";
    btn.appendChild(el("span", "decoded-error-msg", item.message));
    btn.appendChild(
      el("span", "decoded-error-loc", `${item.file}:${item.line}`)
    );
    btn.addEventListener("click", () =>
      vscode.postMessage({ type: "explainDiagnostic", key: item.key })
    );
    li.appendChild(btn);
    errorsList.appendChild(li);
  }
}

// --- History drawer. ---

const historyDrawer = byId<HTMLElement>("history-drawer");
const historyList = byId<HTMLElement>("history-list");
byId<HTMLButtonElement>("history-toggle").addEventListener("click", () => {
  historyDrawer.hidden = !historyDrawer.hidden;
});

function relativeTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function renderHistory(items: HistorySummary[]): void {
  historyList.replaceChildren();
  if (items.length === 0) {
    historyList.appendChild(
      el("li", "decoded-no-errors", "No saved explanations yet.")
    );
    return;
  }
  for (const item of items) {
    const li = el("li", "decoded-history-item");
    const btn = el("button", "decoded-error-btn");
    btn.type = "button";
    btn.appendChild(el("span", "decoded-error-msg", item.title));
    btn.appendChild(
      el(
        "span",
        "decoded-error-loc",
        `${item.language} · ${relativeTime(item.timestamp)}`
      )
    );
    btn.addEventListener("click", () => {
      historyDrawer.hidden = true;
      vscode.postMessage({ type: "loadHistory", id: item.id });
    });
    li.appendChild(btn);
    historyList.appendChild(li);
  }
}

// --- Busy state + composer. ---

const busyBar = byId<HTMLElement>("busy");
const busyLabel = byId<HTMLElement>("busy-label");
const input = byId<HTMLTextAreaElement>("input");
const sendBtn = byId<HTMLButtonElement>("send");
const addContextBtn = byId<HTMLButtonElement>("add-context");
const modelBtn = byId<HTMLButtonElement>("model-btn");
const modelBtnLabel = byId<HTMLElement>("model-btn-label");
const modelMenu = byId<HTMLElement>("model-menu");
const chipsRow = byId<HTMLElement>("context-chips");

function setBusy(value: boolean, label?: string): void {
  busyBar.hidden = !value;
  busyLabel.textContent = label ?? "Thinking…";
  input.disabled = value;
  sendBtn.disabled = value;
  addContextBtn.disabled = value;
  modelBtn.disabled = value;
  if (value) {
    hideModelMenu();
    busyBar.scrollIntoView({ block: "end" });
  }
}

// --- Context chips (the + button). ---

let chips: Chip[] = [];

function renderChips(): void {
  chipsRow.replaceChildren();
  chipsRow.hidden = chips.length === 0;
  for (const chip of chips) {
    const pill = el("span", "decoded-chip");
    pill.title = chip.detail;
    pill.appendChild(el("span", "decoded-chip-label", chip.label));
    const remove = el("button", "decoded-chip-remove", "×");
    remove.type = "button";
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      chips = chips.filter((c) => c.id !== chip.id);
      renderChips();
      vscode.postMessage({ type: "removeContext", id: chip.id });
    });
    pill.appendChild(remove);
    chipsRow.appendChild(pill);
  }
}

addContextBtn.addEventListener("click", () =>
  vscode.postMessage({ type: "pickContext" })
);

function send(): void {
  const text = input.value.trim();
  if (!text || input.disabled) {
    return;
  }
  vscode.postMessage({
    type: "followUp",
    text,
    contextIds: chips.map((c) => c.id),
  });
  input.value = "";
  chips = [];
  renderChips();
}

sendBtn.addEventListener("click", send);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// --- Model picker (the dropdown in the input box, like Copilot). ---

let providers: ProviderInfo[] = [];
let activeProviderId = "";
let activeModel = "";
let activeProviderLabel = "";

// "qwen/qwen3-coder:free" → "qwen3-coder (free)" so it fits the button.
function shortModelName(model: string): string {
  const base = model.split("/").pop() ?? model;
  return base.endsWith(":free")
    ? `${base.slice(0, -":free".length)} (free)`
    : base;
}

function buildModelMenu(): void {
  modelMenu.replaceChildren();
  for (const p of providers) {
    modelMenu.appendChild(el("div", "decoded-menu-group", p.label));
    for (const m of p.models) {
      const isActive = p.id === activeProviderId && m === activeModel;
      const btn = el(
        "button",
        `decoded-menu-item${isActive ? " decoded-menu-active" : ""}`
      );
      btn.type = "button";
      btn.appendChild(el("span", "decoded-menu-check", isActive ? "✓" : ""));
      btn.appendChild(el("span", "decoded-menu-model", m));
      btn.addEventListener("click", () => {
        hideModelMenu();
        vscode.postMessage({ type: "selectModel", providerId: p.id, model: m });
      });
      modelMenu.appendChild(btn);
    }
  }
}

function hideModelMenu(): void {
  modelMenu.hidden = true;
}

modelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (modelMenu.hidden) {
    buildModelMenu();
    modelMenu.hidden = false;
  } else {
    hideModelMenu();
  }
});

// Close the menu on outside click or Escape.
document.addEventListener("click", (e) => {
  if (!modelMenu.hidden && !modelMenu.contains(e.target as Node)) {
    hideModelMenu();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideModelMenu();
  }
});

function setConfig(config: {
  providerId?: string;
  provider: string;
  model: string;
  providers?: ProviderInfo[];
}): void {
  activeProviderId = config.providerId ?? "";
  activeProviderLabel = config.provider;
  activeModel = config.model;
  if (config.providers) {
    providers = config.providers;
  }
  byId<HTMLElement>("provider-label").textContent =
    `${config.provider} · ${config.model}`;
  modelBtnLabel.textContent = shortModelName(config.model);
  // If the menu is open (e.g. /model changed settings), refresh the ✓ mark.
  if (!modelMenu.hidden) {
    buildModelMenu();
  }
}

// --- Message routing. ---

window.addEventListener("message", (event) => {
  const msg = event.data as Record<string, unknown>;
  switch (msg.type) {
    case "init": {
      setConfig(
        msg.config as {
          providerId?: string;
          provider: string;
          model: string;
          providers?: ProviderInfo[];
        }
      );
      renderHistory(msg.history as HistorySummary[]);
      renderErrors(msg.errors as ErrorItem[]);
      transcript.replaceChildren();
      const items = msg.transcript as TranscriptItem[];
      if (items.length === 0) {
        renderEmptyState();
      } else {
        for (const item of items) {
          renderItem(item);
        }
      }
      setBusy(Boolean(msg.busy));
      break;
    }
    case "append":
      renderItem(msg.item as TranscriptItem);
      break;
    case "errors":
      renderErrors(msg.items as ErrorItem[]);
      break;
    case "history":
      renderHistory(msg.items as HistorySummary[]);
      break;
    case "busy":
      setBusy(Boolean(msg.value), msg.label as string | undefined);
      break;
    case "config":
      setConfig(
        msg as unknown as {
          providerId?: string;
          provider: string;
          model: string;
          providers?: ProviderInfo[];
        }
      );
      break;
    case "contextChip":
      chips.push(msg.chip as Chip);
      renderChips();
      break;
    case "reset":
      transcript.replaceChildren();
      renderEmptyState();
      break;
  }
});

// Tell the extension we're ready for the initial state.
vscode.postMessage({ type: "ready" });
