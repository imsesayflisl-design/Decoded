const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Reports esbuild errors in a format VS Code's problem matcher understands.
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log("[watch] build finished");
    });
  },
};

// The extension host bundle (Node, CJS, vscode external).
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "dist/extension.js",
  // The vscode module is provided by the host at runtime; never bundle it.
  external: ["vscode"],
  logLevel: "silent",
  plugins: [esbuildProblemMatcherPlugin],
};

// The webview bundle (browser, IIFE) — includes highlight.js for code coloring.
const webviewConfig = {
  entryPoints: ["src/webview/chat.ts"],
  bundle: true,
  format: "iife",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  outfile: "dist/webview.js",
  logLevel: "silent",
  plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
  const extCtx = await esbuild.context(extensionConfig);
  const webCtx = await esbuild.context(webviewConfig);

  if (watch) {
    await Promise.all([extCtx.watch(), webCtx.watch()]);
  } else {
    await Promise.all([extCtx.rebuild(), webCtx.rebuild()]);
    await extCtx.dispose();
    await webCtx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
