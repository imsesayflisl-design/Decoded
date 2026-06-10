# Decoded

A VS Code extension that explains your errors to teach you, right where you code.

Decoded watches your code for problems and lists them in its sidebar as they appear. Click one (or trigger Decoded on a squiggle) and it explains the error in four parts — what it means, why it's happening in your code, how to fix it, and how to avoid it next time — as a chat reply, with follow-up questions welcome. It reads the error and surrounding code straight from VS Code, so there's nothing to copy and paste.

## Features

- **Chat sidebar** — click the Decoded icon in the activity bar: current problems are listed at the top, explanations arrive as chat replies, and you can ask follow-up questions in the input box.
- **Automatic error detection** — Decoded watches diagnostics across your workspace and lists them live. The AI is only called when you click a problem (or trigger Explain Error), so idle watching costs nothing.
- **Workspace scan + fix-it-for-me** — when you open the sidebar, Decoded reads your codebase (opens source files so language servers report problems), tells you what it found, and **asks before fixing anything**. Say yes and it fixes errors one by one (capped at 10 per run, unsaved so Undo works). Trigger a scan anytime with the **Scan** button, by typing "scan my code" in the chat, or via **Decoded: Scan Workspace for Errors**.
- **Four-part teaching answer** — what it means → why → how to fix (Before/After, with an Apply fix button) → how to avoid next time, with syntax highlighting.
- **Your choice of AI** — Anthropic (Claude), OpenAI (GPT), or Google (Gemini), each with selectable models. Switch any time with **Decoded: Select AI Provider**.
- **Native triggers** — lightbulb quick-fix on diagnostics, right-click menu, and a configurable keybinding (`Ctrl+Alt+D` / `Cmd+Alt+D`).
- **Secure keys** — API keys are stored per provider in VS Code SecretStorage (never in settings, code, or logs).
- **History** — past explanations are saved locally and reopen from the History drawer in the sidebar.

## Settings

| Setting | Description |
| --- | --- |
| `decoded.provider` | `anthropic` (default), `openai`, or `gemini` |
| `decoded.anthropic.model` | Claude model (default `claude-opus-4-8`) |
| `decoded.openai.model` | GPT model (default `gpt-5-mini`) |
| `decoded.gemini.model` | Gemini model (default `gemini-2.5-flash`) |
| `decoded.errors.includeWarnings` | Also list warnings in the sidebar (default off) |
| `decoded.errors.maxListed` | Cap on listed problems (default 50) |

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
│   ├── applyFix.ts      # "Apply fix" editor edit
│   ├── providers/       # AI provider abstraction
│   │   ├── types.ts     # LLMProvider interface
│   │   ├── explain.ts   # teaching prompt + JSON contract + Zod validation
│   │   ├── anthropic.ts # Claude adapter
│   │   ├── openai.ts    # GPT adapter
│   │   ├── gemini.ts    # Gemini adapter
│   │   └── index.ts     # registry + active provider
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

## Packaging

```bash
npx @vscode/vsce package --no-dependencies   # → decoded-0.0.1.vsix
code --install-extension decoded-0.0.1.vsix  # install locally
```
