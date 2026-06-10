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

function renderEmptyState(): void {
  const empty = el("div", "decoded-empty");
  empty.appendChild(el("h2", undefined, "Decoded"));
  empty.appendChild(
    el(
      "p",
      undefined,
      "Errors in your code show up under Problems above. Click one and Decoded explains it in four parts — then ask follow-up questions below."
    )
  );
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

function renderItem(item: TranscriptItem): void {
  clearEmptyState();
  let node: HTMLElement;
  switch (item.kind) {
    case "user":
      node = el("div", "decoded-msg decoded-msg-user", item.title);
      break;
    case "explanation":
      node = renderExplanation(item);
      break;
    case "assistant": {
      node = el("div", "decoded-msg decoded-msg-assistant");
      node.appendChild(renderMarkdown(item.markdown));
      break;
    }
    case "error":
      node = el("div", "decoded-msg decoded-msg-error", item.message);
      break;
    case "prompt":
      node = renderPrompt(item);
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

function setBusy(value: boolean, label?: string): void {
  busyBar.hidden = !value;
  busyLabel.textContent = label ?? "Thinking…";
  input.disabled = value;
  sendBtn.disabled = value;
  if (value) {
    busyBar.scrollIntoView({ block: "end" });
  }
}

function send(): void {
  const text = input.value.trim();
  if (!text || input.disabled) {
    return;
  }
  vscode.postMessage({ type: "followUp", text });
  input.value = "";
}

sendBtn.addEventListener("click", send);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// --- Provider label. ---

function setConfig(config: { provider: string; model: string }): void {
  byId<HTMLElement>("provider-label").textContent =
    `${config.provider} · ${config.model}`;
}

// --- Message routing. ---

window.addEventListener("message", (event) => {
  const msg = event.data as Record<string, unknown>;
  switch (msg.type) {
    case "init": {
      setConfig(msg.config as { provider: string; model: string });
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
      setConfig(msg as unknown as { provider: string; model: string });
      break;
    case "reset":
      transcript.replaceChildren();
      renderEmptyState();
      break;
  }
});

// Tell the extension we're ready for the initial state.
vscode.postMessage({ type: "ready" });
