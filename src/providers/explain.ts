import type { ZodType } from "zod";
import { ExplanationSchema, type Explanation } from "../schema";
import type {
  ChatTurn,
  CompletionRequest,
  LLMProvider,
  ProviderOptions,
} from "./types";

// The teaching system prompt — used EXACTLY as specified in the implementation plan.
export const SYSTEM_PROMPT = `You are Decoded, a patient senior engineer who explains coding errors so the developer actually learns. You receive an error message, and optionally a code snippet and a language. Explain the error in exactly four parts and return ONLY a JSON object — no prose, no markdown fences — in this exact shape:
{
  "language": "...",
  "whatItMeans": { "explanation": "...", "relevantCode": "..." },
  "whyItsHappening": "...",
  "howToFix": { "steps": ["...", "..."], "brokenCode": "...", "correctedCode": "..." },
  "fixCommand": "...",
  "howToAvoidNextTime": "..."
}
Rules:
- whatItMeans.explanation: 1-3 plain-English sentences, no jargon dump. whatItMeans.relevantCode: the exact line or snippet the error points to (from the user's code if provided, otherwise a short representative example).
- whyItsHappening: the single most likely cause in THIS specific case; reference the user's actual code or values when provided. Do not list many possibilities.
- howToFix.steps: short numbered steps. howToFix.brokenCode: the user's relevant broken code. howToFix.correctedCode: the minimal corrected version (use "" when the fix is a command, not a code change).
- fixCommand: when the right fix is a terminal command (e.g. an install for a missing dependency like "npm install", a missing package "npm install <pkg>", "pip install <pkg>", running a build, etc.), put the single exact command here; otherwise "". For run/setup/dependency/environment errors, prefer the command. Pick the package manager from the project's lockfile if mentioned (package-lock.json->npm, yarn.lock->yarn, pnpm-lock.yaml->pnpm).
- howToAvoidNextTime: one practical habit or rule that prevents this whole class of error.
- If language is missing, detect it and set the language field.
- If no code is provided or the error is vague, state your assumption inside the relevant field and still give a useful general cause, keeping the four-part structure.
Return only the JSON.`;

// System prompt for conversational follow-up questions after an explanation.
export const FOLLOW_UP_SYSTEM_PROMPT = `You are Decoded, a patient senior engineer. You already explained a coding error to the developer in a structured four-part format (what it means, why it's happening, how to fix it, how to avoid it next time). Now answer their follow-up questions conversationally.
Rules:
- Answer in plain markdown — no JSON, no four-part structure.
- Stay focused on this error, the user's code, and closely related concepts.
- Keep answers short and concrete; put any code in fenced code blocks with a language tag.
- Teach, don't just patch: explain the why behind your answer in a sentence or two.`;

// System prompt for "Ask Decoded" — general engineering Q&A that is also
// codebase-aware when CONTEXT blocks (the user's files) are provided.
export const ASK_SYSTEM_PROMPT = `You are Decoded, a patient senior engineer who helps developers understand software, not just copy fixes. Answer ANY software-engineering question clearly: concepts, "how do I…", debugging, best practices, language/framework/tooling, architecture advice, or explaining code the user shares. Always try to help.
Rules:
- Answer in plain markdown — put code in fenced code blocks with a language tag.
- When CONTEXT blocks (the user's own files/snippets) are provided, ground your answer in THAT code: refer to the real names, files, and lines, and explain how the code actually works.
- If the provided context isn't enough to be sure, say what else you'd need (e.g. which file) instead of guessing.
- Teach: explain the "why", not only the "what". Keep it focused and concrete; avoid filler.
- Do not invent files, APIs, or behaviour that aren't supported by the context or well-established knowledge.`;

// The JSON Schema for the four-part explanation, hand-written once and shared
// by every provider's structured-output mode. Kept deliberately simple
// (objects + strings + one string array) so it satisfies OpenAI's strict mode
// (additionalProperties: false, all fields required) and Gemini's schema
// dialect alike. Zod (ExplanationSchema) remains the final authority.
export const EXPLANATION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    language: { type: "string" },
    whatItMeans: {
      type: "object",
      properties: {
        explanation: { type: "string" },
        relevantCode: { type: "string" },
      },
      required: ["explanation", "relevantCode"],
      additionalProperties: false,
    },
    whyItsHappening: { type: "string" },
    howToFix: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "string" } },
        brokenCode: { type: "string" },
        correctedCode: { type: "string" },
      },
      required: ["steps", "brokenCode", "correctedCode"],
      additionalProperties: false,
    },
    fixCommand: { type: "string" },
    howToAvoidNextTime: { type: "string" },
  },
  required: [
    "language",
    "whatItMeans",
    "whyItsHappening",
    "howToFix",
    "fixCommand",
    "howToAvoidNextTime",
  ],
  additionalProperties: false,
};

// Token budgets: explanations are structured and short; follow-ups can ramble
// a little more freely but still stay conversational.
const EXPLAIN_MAX_TOKENS = 4000;
const CHAT_MAX_TOKENS = 2000;

// What we send to the model about the error the user hit.
export interface ExplainInput {
  errorMessage: string;
  code?: string;
  language?: string;
}

// Builds the user-facing message content from the gathered error + context.
export function buildUserMessage(input: ExplainInput): string {
  const parts: string[] = [];
  parts.push(`ERROR MESSAGE:\n${input.errorMessage}`);
  if (input.language) {
    parts.push(`LANGUAGE:\n${input.language}`);
  }
  if (input.code) {
    parts.push(`CODE CONTEXT:\n${input.code}`);
  }
  return parts.join("\n\n");
}

// Strips accidental markdown fences and grabs the JSON object from the text.
function extractJson(text: string): string {
  let t = text.trim();
  // Remove ```json ... ``` or ``` ... ``` fences if the model added them.
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    t = fenced[1].trim();
  }
  // Fall back to the first { ... last } span if there is surrounding prose.
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    t = t.slice(first, last + 1);
  }
  return t;
}

// Generic structured-output call shared by every Decoded JSON feature
// (explain, review, diagnose): sends a JSON-schema request, extracts and
// Zod-validates the reply, and retries ONCE with a stricter reminder before
// giving up. Throws a user-facing Error if the model never returns valid JSON.
export async function runStructured<T>(
  provider: LLMProvider,
  opts: ProviderOptions,
  system: string,
  userMessage: string,
  jsonSchema: Record<string, unknown>,
  schema: ZodType<T>,
  maxTokens: number
): Promise<T> {
  const attempt = async (sys: string): Promise<T | null> => {
    const req: CompletionRequest = {
      system: sys,
      messages: [{ role: "user", content: userMessage }],
      maxTokens,
      jsonSchema,
    };
    const text = await provider.complete(req, opts);
    try {
      const parsed = schema.safeParse(JSON.parse(extractJson(text)));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const first = await attempt(system);
  if (first) {
    return first;
  }
  // Stricter retry: re-state that the reply must match the JSON shape exactly.
  const second = await attempt(
    system +
      "\n\nIMPORTANT: Your previous reply did not match the required JSON shape. Return ONLY the JSON object with exactly the required keys and types. No markdown, no prose."
  );
  if (second) {
    return second;
  }
  throw new Error(
    "The model didn't return a valid response. Please try again."
  );
}

// Calls the provider once and returns validated data, or null if the
// response did not validate against the four-part schema.
async function callOnce(
  provider: LLMProvider,
  opts: ProviderOptions,
  userMessage: string,
  system: string
): Promise<Explanation | null> {
  const req: CompletionRequest = {
    system,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: EXPLAIN_MAX_TOKENS,
    jsonSchema: EXPLANATION_JSON_SCHEMA,
  };
  const text = await provider.complete(req, opts);
  try {
    const parsed = JSON.parse(extractJson(text));
    const result = ExplanationSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Calls the active provider and validates the four-part JSON. If the first
// attempt fails validation, retries once with a stricter reminder.
// Throws on transport/auth errors so the caller can show a clean message.
export async function explainError(
  provider: LLMProvider,
  opts: ProviderOptions,
  input: ExplainInput
): Promise<Explanation> {
  const userMessage = buildUserMessage(input);

  const first = await callOnce(provider, opts, userMessage, SYSTEM_PROMPT);
  if (first) {
    return first;
  }

  // Stricter retry: re-state the contract emphatically.
  const stricterSystem =
    SYSTEM_PROMPT +
    "\n\nIMPORTANT: Your previous reply did not match the required JSON shape. Return ONLY the JSON object with exactly the keys: language, whatItMeans.explanation, whatItMeans.relevantCode, whyItsHappening, howToFix.steps, howToFix.brokenCode, howToFix.correctedCode, fixCommand, howToAvoidNextTime. No markdown, no prose.";

  const second = await callOnce(provider, opts, userMessage, stricterSystem);
  if (second) {
    return second;
  }

  throw new Error(
    "The model did not return a valid four-part explanation. Please try again."
  );
}

// Answers a conversational follow-up. `history` carries the prior turns
// (starting with the original error + serialized explanation); the reply is
// plain markdown.
export async function chat(
  provider: LLMProvider,
  opts: ProviderOptions,
  history: ChatTurn[],
  followUp: string,
  onDelta?: (delta: string) => void,
  system: string = FOLLOW_UP_SYSTEM_PROMPT
): Promise<string> {
  const req: CompletionRequest = {
    system,
    messages: [...history, { role: "user", content: followUp }],
    maxTokens: CHAT_MAX_TOKENS,
  };
  const text = await provider.complete(req, opts, onDelta);
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("The model returned an empty reply. Please try again.");
  }
  return trimmed;
}
