import * as vscode from "vscode";

// File types worth scanning for problems.
const SOURCE_GLOB =
  "**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,cs,c,cpp,h,hpp,go,rs,rb,php,json,html,css,scss,vue,svelte}";
const EXCLUDE_GLOB = "**/{node_modules,dist,out,build,.git,.vscode-test}/**";

// How long to give language servers to publish diagnostics after files open.
const SETTLE_MS = 2000;

// "Reads" the codebase: opening a document fires didOpen, so language
// servers analyze it and publish diagnostics — which DiagnosticsWatcher then
// picks up. No AI call happens here; scanning is free.
export async function scanWorkspace(maxFiles = 150): Promise<number> {
  const uris = await vscode.workspace.findFiles(
    SOURCE_GLOB,
    EXCLUDE_GLOB,
    maxFiles
  );

  let opened = 0;
  // Small batches keep the editor responsive on big folders.
  const BATCH = 10;
  for (let i = 0; i < uris.length; i += BATCH) {
    const batch = uris.slice(i, i + BATCH).map(async (uri) => {
      try {
        await vscode.workspace.openTextDocument(uri);
        opened++;
      } catch {
        // Binary/unreadable file — skip it.
      }
    });
    await Promise.all(batch);
  }

  // Give language servers a moment to analyze and publish.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return opened;
}
