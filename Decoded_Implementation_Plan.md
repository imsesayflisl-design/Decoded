# Implementation Plan — Decoded (AI Build Guide)

> A phase-by-phase set of ready-to-paste prompts for building **Decoded** as a **VS Code extension** with an AI coding assistant such as Claude Code or Cursor. Paste the Project Context prompt once, then work through each phase prompt in order.

| | |
|---|---|
| **Product** | Decoded (VS Code extension) |
| **Author** | Idriss M. Sesay |
| **Version** | 2.0 (AI build guide) |
| **Status** | Draft — for cohort review |
| **Last updated** | June 2026 |

---

## How to use this guide

1. **Get your tools and key ready** — see *Before you start* below.
2. **Paste the Project Context prompt once** so the AI understands the whole project.
3. **Work through the phases in order.** Paste one phase prompt, let the AI build it, then **run and test it before moving on**.
4. **Commit after each phase**, so you always have a working checkpoint.
5. If anything is unclear, ask the AI to explain *why* before you accept it.

> You run a VS Code extension by pressing **F5**, which opens a second VS Code window (the *Extension Development Host*) with your extension loaded — not in a browser.

---

## Before you start — tools & key

**Tools**
- **Node.js** (LTS version) installed
- **VS Code** installed
- Scaffolding generator: `npm install -g yo generator-code`
- Packaging tool (used in Phase 5): `npm install -g @vscode/vsce`

**Key**
- An **Anthropic API key** from **console.anthropic.com** (add a few dollars of credit). You will **not** put it in a file — Decoded stores it through VS Code's **SecretStorage**, set by a command the extension provides. Until that command exists, Phase 1 prompts you for the key and stores it the first time you run an explanation.

**Model:** use **Claude Sonnet 4.6** (`claude-sonnet-4-6`). A Decoded request is small, so each explanation costs well under a cent. (Confirm current model names and pricing on Anthropic's pricing page.)

**For publishing later (optional):** a VS Code Marketplace **publisher** and an **Azure DevOps Personal Access Token**. Not needed to build, run, or demo from a `.vsix`.

---

## The Project Context prompt — paste this first

````text
You are helping me build a VS Code extension called Decoded. Read this context carefully and keep it in mind for every step. Do NOT start coding until I give you a specific build instruction — just confirm you understand.

WHAT DECODED IS
A VS Code extension. When the developer hits an error, they trigger Decoded and it explains that error in four parts, in a panel beside their code, WITHOUT them leaving the editor:
1. What it means — the error in plain English, with the exact line it points to.
2. Why it's happening — the cause in their specific code.
3. How to fix it — steps plus the corrected code next to the broken line.
4. How to avoid it next time — one habit that prevents this class of error.
On-screen rhythm: words, then code, then words, then code.

HOW IT GETS THE ERROR
- If there is a diagnostic (a reported problem / squiggle) at the cursor in the active editor, use its message.
- Otherwise, if there is selected text, use the selection as the error.
- Otherwise, show a message asking the user to put the cursor on an error or select one.
Always also gather the relevant CODE CONTEXT (the error's line plus a few surrounding lines, or the selection) and the document's languageId, and send those with the error.

TECH STACK (use exactly this)
- TypeScript
- VS Code Extension API (@types/vscode)
- esbuild for bundling the extension
- Anthropic SDK (@anthropic-ai/sdk), model "claude-sonnet-4-6"
- Zod to validate the AI's JSON output
- A Webview panel for the four-part display, styled with VS Code theme variables
- @vscode/vsce for packaging (later)

THE AI EXPLANATION MUST BE RETURNED AS JSON IN EXACTLY THIS SHAPE
{
  "language": "...",
  "whatItMeans": { "explanation": "...", "relevantCode": "..." },
  "whyItsHappening": "...",
  "howToFix": { "steps": ["...", "..."], "brokenCode": "...", "correctedCode": "..." },
  "howToAvoidNextTime": "..."
}

STORAGE
- API key: VS Code SecretStorage (never in settings, code, or logs).
- History of explanations: VS Code globalState (a capped list), shown later in a sidebar view.

CONVENTIONS
- TypeScript everywhere; clean, readable code with short comments where helpful.
- Never log or expose the API key.
- Build ONLY what each instruction asks for. After each step, briefly tell me what you changed and how to run/test it (assume I press F5 to launch the Extension Development Host), then stop and wait for my next instruction.

Confirm you understand, then wait for my first build instruction.
````

---

## Phase 0 — Scaffold the extension

**Goal:** a runnable extension skeleton.

````text
Scaffold a VS Code extension. Steps:
1. Generate a new "New Extension (TypeScript)" project using the yo code generator (or set up an equivalent TypeScript extension project), with esbuild configured for bundling.
2. Make sure package.json registers a sample "Hello World" command under contributes.commands and that it works.
3. Install these packages: @anthropic-ai/sdk, zod.
4. Give me the exact commands to install dependencies and build, and tell me how to launch the extension (press F5 to open the Extension Development Host) and run the sample command from the Command Palette.
Do not build any features yet.
````

**Check:** pressing F5 opens a second VS Code window, and running the sample command shows a message.

---

## Phase 1 — The explain engine (core)

**Goal:** put the cursor on a real error, run a command, and get a valid four-part answer. **This is the most important phase.**

````text
Build the core explain flow.

1. Register a command "decoded.explainError" titled "Decoded: Explain Error".

2. When it runs, determine the ERROR to explain:
   - if there is a diagnostic at the cursor position in the active editor, use that diagnostic's message;
   - else if there is selected text, use the selection;
   - else show an information message asking the user to place the cursor on an error or select one, and stop.

3. Gather CONTEXT: the relevant code (the diagnostic's line plus ~5 lines around it, or the selection) and the active document's languageId.

4. API KEY: read it from SecretStorage (key e.g. "decoded.anthropicApiKey"). If it's missing, prompt for it with an input box (password style) and store it in SecretStorage.

5. Call the Anthropic API (model "claude-sonnet-4-6") with EXACTLY this system prompt:

"""
You are Decoded, a patient senior engineer who explains coding errors so the developer actually learns. You receive an error message, and optionally a code snippet and a language. Explain the error in exactly four parts and return ONLY a JSON object — no prose, no markdown fences — in this exact shape:
{
  "language": "...",
  "whatItMeans": { "explanation": "...", "relevantCode": "..." },
  "whyItsHappening": "...",
  "howToFix": { "steps": ["...", "..."], "brokenCode": "...", "correctedCode": "..." },
  "howToAvoidNextTime": "..."
}
Rules:
- whatItMeans.explanation: 1-3 plain-English sentences, no jargon dump. whatItMeans.relevantCode: the exact line or snippet the error points to (from the user's code if provided, otherwise a short representative example).
- whyItsHappening: the single most likely cause in THIS specific case; reference the user's actual code or values when provided. Do not list many possibilities.
- howToFix.steps: short numbered steps. howToFix.brokenCode: the user's relevant broken code. howToFix.correctedCode: the minimal corrected version.
- howToAvoidNextTime: one practical habit or rule that prevents this whole class of error.
- If language is missing, detect it and set the language field.
- If no code is provided or the error is vague, state your assumption inside the relevant field and still give a useful general cause, keeping the four-part structure.
Return only the JSON.
"""

6. VALIDATION: define a Zod schema matching the JSON shape and parse the response. If validation fails, retry once with a stricter instruction; if it still fails, show a clean error message.

7. For now, show the parsed result in an output channel or an information message (the panel comes in Phase 2).

Then tell me how to test it: open a file with a real error, put the cursor on it, and run the command.
````

**Check:** placing the cursor on a real error (or selecting one) and running the command returns a valid four-part result.

---

## Phase 2 — The four-part panel (Webview)

**Goal:** show the explanation in a clean, themed panel.

````text
Render the explanation in a Webview panel instead of a message.
1. Create a Webview panel (beside the editor) that displays the four parts in order, with the rhythm: plain text, then code, then plain text, then code.
2. Syntax-highlight the code fields, and in "How to fix it" show the broken code and corrected code clearly distinguished (labelled Before / After).
3. Style everything using VS Code theme variables (e.g. var(--vscode-editor-background), var(--vscode-foreground), var(--vscode-textLink-foreground), var(--vscode-editorWidget-border)) so it matches the user's current theme, and include a strict Content-Security-Policy in the webview HTML.
4. Reuse the same panel for subsequent explanations (don't open a new one each time).
Keep the Phase 1 logic; this changes presentation only. Tell me how to test it.
````

**Check:** the explanation appears in a themed panel next to the code, with highlighted before/after.

---

## Phase 3 — Native triggers & key management

**Goal:** trigger Decoded the natural VS Code ways, and manage the key cleanly.

````text
Make Decoded feel native.
1. Add a "Decoded: Set API Key" command that stores the key in SecretStorage, and a "Decoded: Clear API Key" command that removes it.
2. Register a CodeAction provider so a lightbulb / quick-fix titled "Explain with Decoded" appears on a diagnostic and runs decoded.explainError for that diagnostic.
3. Add a right-click editor context-menu item for "Decoded: Explain Error", and a default keybinding (make it configurable).
Tell me how to test each trigger: the lightbulb on a squiggle, the right-click menu, the keybinding, and the palette commands.
````

**Check:** Decoded can be triggered from the lightbulb, the right-click menu, a keybinding, and the palette; the key can be set and cleared.

---

## Phase 4 — History & polish

**Goal:** keep a local history and handle the rough edges.

````text
Add history and harden the extension.
1. Save each explanation to globalState as a capped list (e.g. the last 50), storing a short title, language, timestamp, and the four-part result.
2. Add a "Decoded" view in the sidebar (a TreeView) listing past explanations (title + language + time, newest first); clicking one reopens it in the Webview panel.
3. Handle edge cases gracefully (clear messages, never an unhandled crash):
   - no API key set (prompt to set it),
   - no diagnostic and no selection (ask the user to select or place the cursor on an error),
   - an Anthropic API failure or timeout (friendly message in the panel),
   - very long input (cap the code/error length sent).
4. (OPTIONAL STRETCH) add an "Apply fix" button in the panel that inserts the corrected code into the file.
Tell me how to test history and each edge case.
````

**Check:** history persists across sessions and reopens correctly; each edge case is handled cleanly.

---

## Phase 5 — Package & demo

**Goal:** a working, installable extension and a rehearsed demo.

````text
Help me package and run Decoded as a real extension.
1. Produce a production bundle with esbuild, then run vsce package to create a .vsix file.
2. Tell me how to install the .vsix locally (the "Install from VSIX" option in the Extensions view, or `code --install-extension <file>.vsix`) and verify it works as an installed extension.
3. (OPTIONAL) outline how to publish to the VS Code Marketplace (create a publisher, get an Azure DevOps Personal Access Token, then `vsce publish`).
4. Give me a short pre-demo checklist to smoke-test the installed extension end to end.
````

**Then, on your own:** open a project that has a real bug, trigger Decoded from the lightbulb on the squiggle, walk through the four parts in the panel, then reopen it from the history view. Keep a screenshot or a backup in case of network issues during the demo.

---

## Phase summary

| Phase | What the AI builds | You should be able to… |
|---|---|---|
| 0 | TypeScript extension scaffold (yo code) + esbuild | press F5 and run a sample command |
| 1 | `decoded.explainError`: read diagnostic/selection + code, call the AI, validate | put the cursor on an error and get a four-part answer |
| 2 | Themed Webview panel with highlighted before/after | read a clean, in-editor explanation |
| 3 | Lightbulb action, context menu, keybinding, Set/Clear API Key | trigger Decoded the natural VS Code ways |
| 4 | globalState history + sidebar view + edge cases | revisit past explanations; trust it with messy input |
| 5 | `.vsix` package (+ optional Marketplace) | install and demo it as a real extension |

---

## A note on the engine

The core of Decoded is **Phase 1** — reading the right error and code context from the editor, and getting the same disciplined four-part teaching answer back every time. The Webview, the native triggers, and the history are presentation and convenience layered on top. Get Phase 1 solid, test the teaching prompt against many real errors, and the rest follows.
