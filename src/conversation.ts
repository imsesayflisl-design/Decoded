import type { Explanation } from "./schema";
import type { ExplainInput } from "./providers/explain";
import { buildUserMessage } from "./providers/explain";
import type { ChatTurn } from "./providers/types";

// Keep the conversation context bounded: the newest turns win, but the
// origin pair (error + explanation) is never dropped.
const MAX_TURNS = 10;
const MAX_CONTEXT_CHARS = 24000;

// Holds the active chat session so follow-up questions carry context.
export class ConversationManager {
  private origin:
    | { userMessage: string; explanation: Explanation }
    | undefined;
  private turns: ChatTurn[] = [];

  // Starts a fresh session anchored on an explained error.
  startSession(input: ExplainInput, explanation: Explanation): void {
    this.origin = { userMessage: buildUserMessage(input), explanation };
    this.turns = [];
  }

  // Starts a session from a reopened history entry (original code context is
  // no longer available, so the title stands in for the error message).
  startSessionFromHistory(title: string, explanation: Explanation): void {
    this.origin = {
      userMessage: `ERROR MESSAGE:\n${title}`,
      explanation,
    };
    this.turns = [];
  }

  reset(): void {
    this.origin = undefined;
    this.turns = [];
  }

  // Records a completed follow-up exchange.
  addExchange(question: string, answer: string): void {
    this.turns.push({ role: "user", content: question });
    this.turns.push({ role: "assistant", content: answer });
    if (this.turns.length > MAX_TURNS * 2) {
      this.turns = this.turns.slice(-MAX_TURNS * 2);
    }
  }

  // Builds the provider-neutral history for the next follow-up: the origin
  // pair first, then as many recent turns as fit the character budget.
  buildHistory(): ChatTurn[] {
    const head: ChatTurn[] = this.origin
      ? [
          { role: "user", content: this.origin.userMessage },
          {
            role: "assistant",
            content: JSON.stringify(this.origin.explanation),
          },
        ]
      : [];

    const headChars = head.reduce((n, t) => n + t.content.length, 0);
    let budget = MAX_CONTEXT_CHARS - headChars;

    // Walk newest-to-oldest, keeping whole user/assistant pairs that fit.
    const kept: ChatTurn[] = [];
    for (let i = this.turns.length - 2; i >= 0; i -= 2) {
      const pair = this.turns.slice(i, i + 2);
      const pairChars = pair.reduce((n, t) => n + t.content.length, 0);
      if (pairChars > budget) {
        break;
      }
      budget -= pairChars;
      kept.unshift(...pair);
    }
    return [...head, ...kept];
  }
}
