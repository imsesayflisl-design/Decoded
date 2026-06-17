# Decoded

An extension for VS Code and compatible editors that explains your errors to teach you, right where you code. Works in VS Code, Cursor, VSCodium, Windsurf, Gitpod, GitHub Codespaces, code-server, and any other VS Code-compatible editor.

## Install (VS Code, Cursor, Antigravity, or any VS Code-compatible editor)

1. Download the latest `decoded-x.x.x.vsix` from the [Releases page](https://github.com/imsesayflisl-design/Decoded/releases).
2. In your editor, open the **Extensions** panel → click the `…` menu (top right) → **Install from VSIX…** → pick the downloaded file.
   - Or from a terminal: `code --install-extension decoded-0.1.0.vsix` (use `cursor`/`antigravity`/your editor's CLI instead of `code`).
3. Click the **Decoded** icon in the activity bar, and set an API key when asked (or run **Decoded: Set API Key**). The default is **Anthropic (Claude)**, but it also works with OpenAI, Google Gemini, or OpenRouter (which includes free Qwen, Llama, and DeepSeek models) — bring your own key.

> Each editor stores its own keys, so enter your key once per editor.

**Decoded teaches you — it never fixes your code for you.** It watches your code and your terminal for problems. When something breaks, it explains, in plain everyday language, what it means, why it's happening in *your* project, how to fix it yourself, and how to avoid it next time — then leaves the fixing to you, so you actually learn. It reads the error and surrounding code straight from your editor, so there's nothing to copy and paste.

## Features

- **Chat sidebar** — click the Decoded icon in the activity bar: current problems are listed at the top, explanations arrive as chat replies, and you can ask follow-up questions in the input box.
- **Terminal error capture** — when a command in your terminal fails (e.g. `npm run dev` can't find a package), Decoded quietly notices and shows a **"⚠ A command failed — Explain this error"** card plus a badge on its icon. Nothing is sent to the AI until you click **Explain**, then it tells you what's wrong and the exact command to fix it (with a **Copy command** button). Turn it off with `decoded.terminal.autoDetect`.
- **Automatic error detection** — Decoded watches diagnostics across your workspace and lists them live. The AI is only called when you click a problem (or trigger Explain Error), so idle watching costs nothing.
- **Workspace scan** — when you open the sidebar, Decoded reads your codebase (opens source files so language servers report problems) and tells you what it found, then points you to the Problems list so you can click any one for a full lesson. Trigger a scan anytime with the **Scan** button, by typing "scan my code" in the chat, or via **Decoded: Scan Workspace for Errors**.
- **Four-part teaching answer** — what it means → why it's happening → how to fix it → how to avoid next time, in plain beginner-friendly language and with syntax highlighting. Code fixes are shown Before/After so you can type them yourself; terminal fixes come with a **Copy command** button. Decoded never edits your files or runs commands for you.
- **Streaming answers** — replies stream into the chat as they're generated, so you start reading right away instead of waiting for the whole answer.
- **Animated logo** — the Decoded logo gently "breathes" while the AI is thinking, so you always know it's working.
- **Your choice of AI** — Anthropic (Claude, default — `claude-opus-4-8`), OpenAI (GPT), Google (Gemini), or OpenRouter (free Qwen, Llama, and DeepSeek models), each with selectable models. Switch any time with **Decoded: Choose AI Model** or by typing `/model` in the chat — your provider and model are remembered until you change them.
- **Native triggers** — lightbulb quick-fix on diagnostics, right-click menu, terminal right-click **Decoded: Diagnose Error**, and a configurable keybinding (`Ctrl+Alt+D` / `Cmd+Alt+D`).
- **Secure keys** — API keys are stored per provider in your editor's secret storage (SecretStorage — never in settings, code, or logs). Keys for all providers are kept, so switching providers never makes you re-enter a key.
- **History** — past explanations are saved locally and reopen from the History drawer in the sidebar.

## Settings

| Setting | Description |
| --- | --- |
| `decoded.provider` | `anthropic` (default), `openai`, `gemini`, or `openrouter` |
| `decoded.anthropic.model` | Claude model (default `claude-opus-4-8`) |
| `decoded.openai.model` | GPT model (default `gpt-5.4-mini`) |
| `decoded.gemini.model` | Gemini model (default `gemini-3.5-flash`) |
| `decoded.openrouter.model` | OpenRouter model (default `openrouter/auto`; includes free Qwen/Llama/DeepSeek) |
| `decoded.errors.includeWarnings` | Also list warnings in the sidebar (default off) |
| `decoded.errors.maxListed` | Cap on listed problems (default 50) |
| `decoded.terminal.autoDetect` | Notice failed terminal commands and offer to explain them (default on) |

## Project layout

Built the official way — a TypeScript extension scaffolded along the lines of the
[`yo code` generator](https://code.visualstudio.com/api/get-started/your-first-extension)
with the **esbuild** bundler option.

```
.
├── .vscode/             # launch.json, tasks.json (watch), extensions.json
├── src/
│   ├── extension.ts     # activate/deactivate, command + view wiring
│   ├── explain.ts       # read diagnostic/selection + context, run the flow
│   ├── chatView.ts      # sidebar chat WebviewView (strict CSP)
│   ├── conversation.ts  # follow-up chat context management
│   ├── diagnostics.ts   # debounced workspace error watcher
│   ├── terminalCapture.ts # auto-detect failed terminal commands (explain on click)
│   ├── diagnose.ts      # break a run/setup error down + suggest the fix command
│   ├── projectContext.ts # lightweight project inspection (deps, lockfile, .env)
│   ├── providers/       # AI provider abstraction
│   │   ├── types.ts     # LLMProvider interface
│   │   ├── explain.ts   # teaching prompt + JSON contract + Zod validation
│   │   ├── anthropic.ts # Claude adapter
│   │   ├── openai.ts     # GPT adapter
│   │   ├── gemini.ts     # Gemini adapter
│   │   ├── openrouter.ts # OpenRouter adapter (Qwen/Llama/DeepSeek)
│   │   └── index.ts      # registry + active provider
│   ├── webview/chat.ts  # webview script (highlight.js) → dist/webview.js
│   └── test/            # @vscode/test-cli tests
├── media/               # icon.png, decoded.svg (activity bar), chat.css
├── esbuild.js           # bundles extension + webview → dist/
├── eslint.config.mjs    # flat ESLint config
└── .vscode-test.mjs     # test runner config
```

## Development

```bash
npm install          # install dependencies
npm run compile      # check-types + lint + bundle to dist/
npm run watch        # watch build (tsc + esbuild) — used by F5
npm run lint         # eslint src
npm run check-types  # tsc --noEmit
npm test             # run extension tests (@vscode/test-cli)
npm run build-icon   # regenerate media/icon.png from media/icon.svg
```

Press **F5** in VS Code to launch the Extension Development Host with Decoded loaded,
then click the Decoded icon in the activity bar. Set a key once with
**Decoded: Set API Key** (you'll be asked which provider it's for).

## Packaging & publishing

```bash
npm run vsix                                 # → decoded-0.1.0.vsix
code --install-extension decoded-0.1.0.vsix  # install locally
```

Decoded is published to **both** registries so every compatible editor can install it:

- **VS Code Marketplace** (VS Code): `npm run publish:vscode` — needs a [VS Code Marketplace PAT](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) (`vsce login idriss-sesay` or `VSCE_PAT` env var).
- **Open VSX** (Cursor, VSCodium, Gitpod, code-server, …): `npm run publish:openvsx` — needs an [Open VSX token](https://open-vsx.org/) (`OVSX_PAT` env var or `npm run publish:openvsx -- -p <token>`).
