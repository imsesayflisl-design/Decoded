// Codebase awareness for "Ask Decoded": gathers the most relevant code from the
// workspace to answer a question, without sending the whole repo. Combines:
//   - the active editor's file + any selection (default),
//   - @-mentioned files/folders in the question,
//   - lightweight retrieval (workspace symbol search + filename/keyword search),
// always excluding node_modules/.git/build output, capped to a token budget,
// and transparent about which files were read.
import * as vscode from "vscode";

// Never read these — noise, huge, or not source. Mirrors common .gitignore.
const EXCLUDE_GLOB =
  "**/{node_modules,.git,dist,out,build,.next,.nuxt,.svelte-kit,coverage,.vscode-test,vendor,__pycache__}/**";

// Budgets keep cost bounded. Chars are a rough proxy for tokens (~4 chars/token).
const MAX_FILE_CHARS = 12000;
const MAX_TOTAL_CHARS = 28000;
const MAX_RETRIEVED_FILES = 6;

// What was read, for the transparency footer.
export interface FileRef {
  label: string; // workspace-relative path, optionally with :start-end
  uri: string;
}

export interface AskContext {
  // Formatted CONTEXT blocks to prepend to the question ("" when none).
  blocks: string;
  // Files (and ranges) actually read, for the "Read to answer" footer.
  filesRead: FileRef[];
  // True when relevant content was trimmed to fit the budget.
  truncated: boolean;
}

// Common words to ignore when turning a question into search terms.
const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","do","does","did",
  "how","what","why","where","when","which","who","whom","this","that","these",
  "those","i","you","we","they","it","my","our","your","their","in","on","at",
  "to","for","of","and","or","but","with","from","by","as","about","into","not",
  "can","could","should","would","will","won't","cant","can't","function","file",
  "code","project","work","works","working","here","there","please","explain",
  "show","tell","me","decoded","use","using","help","get","set","make","need",
]);

// Pulls likely identifiers + keywords from the question for searching.
function searchTerms(question: string): string[] {
  const raw = question.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const w of raw) {
    const key = w.toLowerCase();
    if (STOPWORDS.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    terms.push(w);
  }
  // Identifier-looking terms (camelCase, snake_case, PascalCase) first.
  terms.sort((a, b) => score(b) - score(a));
  return terms.slice(0, 8);
}

function score(term: string): number {
  let s = 0;
  if (/[A-Z]/.test(term) && /[a-z]/.test(term)) {
    s += 2; // camelCase / PascalCase
  }
  if (term.includes("_")) {
    s += 1;
  }
  if (term.length >= 6) {
    s += 1;
  }
  return s;
}

// Extracts @path tokens (e.g. "@src/auth.ts", "@src/components").
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const re = /@([\w./\\-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

// Resolves an @mention to file URIs (a file, or all source files in a folder).
async function resolveMention(token: string): Promise<vscode.Uri[]> {
  // Exact-ish file match anywhere in the workspace.
  const fileMatches = await vscode.workspace.findFiles(
    `**/${token}`,
    EXCLUDE_GLOB,
    5
  );
  if (fileMatches.length > 0) {
    return fileMatches;
  }
  // Otherwise treat it as a folder and grab its files.
  const inFolder = await vscode.workspace.findFiles(
    `**/${token.replace(/\/+$/, "")}/**/*`,
    EXCLUDE_GLOB,
    MAX_RETRIEVED_FILES
  );
  return inFolder;
}

// Finds the most relevant files for a free-form question via symbol search
// (declarations) then filename/keyword search.
async function retrieve(question: string): Promise<vscode.Uri[]> {
  const terms = searchTerms(question);
  const picked: vscode.Uri[] = [];
  const seen = new Set<string>();
  const add = (uri: vscode.Uri) => {
    if (!seen.has(uri.toString())) {
      seen.add(uri.toString());
      picked.push(uri);
    }
  };

  // 1) Symbols: where the named things are declared.
  for (const term of terms.slice(0, 4)) {
    if (picked.length >= MAX_RETRIEVED_FILES) {
      break;
    }
    try {
      const symbols = await vscode.commands.executeCommand<
        vscode.SymbolInformation[]
      >("vscode.executeWorkspaceSymbolProvider", term);
      for (const sym of symbols ?? []) {
        const uri = sym.location?.uri;
        if (uri && !isExcluded(uri)) {
          add(uri);
        }
        if (picked.length >= MAX_RETRIEVED_FILES) {
          break;
        }
      }
    } catch {
      // provider not ready / unsupported language — fall through to filenames
    }
  }

  // 2) Filenames containing the terms.
  for (const term of terms) {
    if (picked.length >= MAX_RETRIEVED_FILES) {
      break;
    }
    const matches = await vscode.workspace.findFiles(
      `**/*${term}*`,
      EXCLUDE_GLOB,
      3
    );
    for (const uri of matches) {
      add(uri);
    }
  }
  return picked.slice(0, MAX_RETRIEVED_FILES);
}

function isExcluded(uri: vscode.Uri): boolean {
  return /[\\/](node_modules|\.git|dist|out|build|\.next|coverage)[\\/]/.test(
    uri.fsPath
  );
}

function cap(text: string): { text: string; truncated: boolean } {
  if (text.length > MAX_FILE_CHARS) {
    return { text: text.slice(0, MAX_FILE_CHARS) + "\n…[truncated]", truncated: true };
  }
  return { text, truncated: false };
}

// Gathers Ask context. `excludeUris` are files already attached as chips, so we
// don't read them twice.
export async function gatherAskContext(
  question: string,
  excludeUris: Set<string>
): Promise<AskContext> {
  const blocks: string[] = [];
  const filesRead: FileRef[] = [];
  const used = new Set<string>(excludeUris);
  let total = 0;
  let truncated = false;

  const addFile = async (
    uri: vscode.Uri,
    range?: vscode.Range
  ): Promise<void> => {
    const key = uri.toString();
    if (used.has(key) || total >= MAX_TOTAL_CHARS) {
      if (total >= MAX_TOTAL_CHARS) {
        truncated = true;
      }
      return;
    }
    used.add(key);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const rel = vscode.workspace.asRelativePath(uri);
      let body: string;
      let label: string;
      if (range) {
        const r = doc.validateRange(range);
        body = doc.getText(r);
        label = `${rel}:${r.start.line + 1}-${r.end.line + 1}`;
      } else {
        body = doc.getText();
        label = rel;
      }
      if (!body.trim()) {
        return;
      }
      const capped = cap(body);
      if (capped.truncated) {
        truncated = true;
      }
      if (total + capped.text.length > MAX_TOTAL_CHARS) {
        truncated = true;
        return;
      }
      total += capped.text.length;
      blocks.push(`CONTEXT — ${label}:\n\`\`\`\n${capped.text}\n\`\`\``);
      filesRead.push({ label, uri: key });
    } catch {
      // unreadable / binary — skip
    }
  };

  // 1) Default: the active editor's file + selection.
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === "file") {
    if (!editor.selection.isEmpty) {
      await addFile(editor.document.uri, editor.selection);
    }
    await addFile(editor.document.uri);
  }

  // 2) @-mentioned files/folders.
  for (const token of parseMentions(question)) {
    for (const uri of await resolveMention(token)) {
      await addFile(uri);
    }
  }

  // 3) Lightweight retrieval for broader questions.
  for (const uri of await retrieve(question)) {
    await addFile(uri);
  }

  return { blocks: blocks.join("\n\n"), filesRead, truncated };
}
