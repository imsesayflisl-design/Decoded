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
  "howToAvoidNextTime": "..."
}
Rules:
- whatItMeans.explanation: 1-3 plain-English sentences, no jargon dump. whatItMeans.relevantCode: the exact line or snippet the error points to (from the user's code if provided, otherwise a short representative example).
- whyItsHappening: the single most likely cause in THIS specific case; reference the user's actual code or values when provided. Do not list many possibilities.
- howToFix.steps: short numbered steps. howToFix.brokenCode: the user's relevant broken code. howToFix.correctedCode: the minimal corrected version.
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
    howToAvoidNextTime: { type: "string" },
  },
  required: [
    "language",
    "whatItMeans",
    "whyItsHappening",
    "howToFix",
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
    "\n\nIMPORTANT: Your previous reply did not match the required JSON shape. Return ONLY the JSON object with exactly the keys: language, whatItMeans.explanation, whatItMeans.relevantCode, whyItsHappening, howToFix.steps, howToFix.brokenCode, howToFix.correctedCode, howToAvoidNextTime. No markdown, no prose.";

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
  followUp: string
): Promise<string> {
  const req: CompletionRequest = {
    system: FOLLOW_UP_SYSTEM_PROMPT,
    messages: [...history, { role: "user", content: followUp }],
    maxTokens: CHAT_MAX_TOKENS,
  };
  const text = await provider.complete(req, opts);
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("The model returned an empty reply. Please try again.");
  }
  return trimmed;
}
