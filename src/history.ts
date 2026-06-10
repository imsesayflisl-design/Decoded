import * as vscode from "vscode";
import type { Explanation } from "./schema";

// One saved explanation.
export interface HistoryEntry {
  id: string;
  title: string;
  language: string;
  timestamp: number;
  result: Explanation;
}

const STORAGE_KEY = "decoded.history";
const MAX_ENTRIES = 50;

// Persists a capped list of past explanations in VS Code globalState
// (stays on the user's machine — never sent anywhere).
export class HistoryStore {
  private readonly emitter = new vscode.EventEmitter<void>();
  // Fires whenever the history changes, so the tree view can refresh.
  readonly onDidChange = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // Newest first.
  getAll(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(STORAGE_KEY, []);
  }

  get(id: string): HistoryEntry | undefined {
    return this.getAll().find((e) => e.id === id);
  }

  // Adds an explanation, trimming to the cap, and notifies listeners.
  async add(title: string, result: Explanation): Promise<void> {
    const entry: HistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: title.trim() || "Explanation",
      language: result.language,
      timestamp: Date.now(),
      result,
    };
    const next = [entry, ...this.getAll()].slice(0, MAX_ENTRIES);
    await this.context.globalState.update(STORAGE_KEY, next);
    this.emitter.fire();
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, []);
    this.emitter.fire();
  }
}
