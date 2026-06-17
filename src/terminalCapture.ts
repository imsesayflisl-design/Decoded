// Auto-detects failed terminal commands so the user never has to copy/paste an
// error again. Uses VS Code's stable Terminal Shell Integration API: we begin
// reading a command's output the moment it starts, and when it ENDS with a
// non-zero exit code we surface the captured output to the chat view.
//
// Crucially, this does NOT call the AI on its own — capturing is free. It only
// emits the captured text; the extension shows a card with an "Explain" button
// and the model is invoked only when the user clicks it (the "explain on click"
// rule). See decoded-v2-direction.
import * as vscode from "vscode";

// Keep captures small; an explanation only needs the tail of the output where
// the actual error usually lives.
const MAX_CAPTURE_CHARS = 4000;
// Ignore a fresh capture that is identical to one we just emitted (e.g. the
// user re-running the same broken command) within this window.
const DEDUPE_WINDOW_MS = 4000;

export interface CapturedError {
  // The command line that failed (e.g. "npm run dev"), best-effort.
  command: string;
  // The cleaned terminal output (ANSI stripped, tail-capped).
  output: string;
  // The shell's exit code (always non-zero here).
  exitCode: number;
}

// Removes ANSI escape sequences and carriage-return artifacts so the output we
// send to the model (and store) is plain readable text.
function clean(raw: string): string {
  return raw
    // CSI / SGR colour and cursor escapes.
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // OSC sequences (e.g. window-title / shell-integration markers).
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Lone escapes and the bell character.
    .replace(/[\x1b\x07]/g, "")
    // Collapse carriage returns used for in-place progress bars.
    .replace(/\r(?!\n)/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

// Watches every shell-integrated terminal and emits the output of any command
// that exits non-zero.
export class TerminalCaptureWatcher implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CapturedError>();
  // Fires once per failed command (when auto-detect is enabled).
  readonly onDidCaptureError = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  // Per in-flight execution: a promise that resolves to its full output when
  // the command's data stream closes. Keyed by the execution object itself.
  private readonly reads = new Map<
    vscode.TerminalShellExecution,
    Promise<string>
  >();
  private lastEmit = { output: "", at: 0 };

  constructor() {
    // The API is only present on VS Code ≥ 1.93. Guard so older hosts (and the
    // test runner) don't throw.
    const onStart = vscode.window.onDidStartTerminalShellExecution?.bind(
      vscode.window
    );
    const onEnd = vscode.window.onDidEndTerminalShellExecution?.bind(
      vscode.window
    );
    if (!onStart || !onEnd) {
      return;
    }

    // Start reading immediately — output written before the first read() is
    // lost, so we must hook the stream here, not on the end event.
    this.disposables.push(
      onStart((e) => {
        this.reads.set(e.execution, this.drain(e.execution));
      })
    );

    this.disposables.push(
      onEnd(async (e) => {
        const pending = this.reads.get(e.execution);
        this.reads.delete(e.execution);
        // undefined exit code = unknown (sub-shell, no shell-integration script);
        // 0 = success. We only care about real failures.
        if (e.exitCode === undefined || e.exitCode === 0) {
          return;
        }
        const raw = pending ? await pending : "";
        const output = clean(raw).trim();
        if (!output) {
          return; // a failure with no captured text isn't actionable
        }
        const tail =
          output.length > MAX_CAPTURE_CHARS
            ? "…(earlier output trimmed)\n" + output.slice(-MAX_CAPTURE_CHARS)
            : output;
        // Drop a duplicate of the command the user just re-ran.
        const now = Date.now();
        if (
          tail === this.lastEmit.output &&
          now - this.lastEmit.at < DEDUPE_WINDOW_MS
        ) {
          return;
        }
        this.lastEmit = { output: tail, at: now };
        this.emitter.fire({
          command: e.execution.commandLine?.value?.trim() ?? "",
          output: tail,
          exitCode: e.exitCode,
        });
      })
    );
  }

  // Reads an execution's data stream to completion, tolerating any read error.
  private async drain(
    execution: vscode.TerminalShellExecution
  ): Promise<string> {
    let acc = "";
    try {
      for await (const chunk of execution.read()) {
        acc += chunk;
        // Bound memory for very chatty commands; we only keep the tail anyway.
        if (acc.length > MAX_CAPTURE_CHARS * 6) {
          acc = acc.slice(-MAX_CAPTURE_CHARS * 4);
        }
      }
    } catch {
      // Stream errored or the terminal closed mid-command — return what we have.
    }
    return acc;
  }

  dispose(): void {
    this.emitter.dispose();
    this.reads.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
