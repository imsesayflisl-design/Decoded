// "Review File" — analyses a whole file and returns every issue (reported
// diagnostics + AI-found missing pieces + likely bugs) as structured JSON,
// validated by ReviewSchema. Reuses the shared runStructured helper so it
// behaves exactly like the four-part explanation (retry-on-invalid included).
import { ReviewSchema, type Review } from "../schema";
import { runStructured } from "./explain";
import type { LLMProvider, ProviderOptions } from "./types";

// A whole-file review can list many issues, so allow more room than a single
// explanation — still capped to keep cost controlled.
const REVIEW_MAX_TOKENS = 6000;

export const REVIEW_SYSTEM_PROMPT = `You are Decoded, a patient senior engineer reviewing a whole source file so the developer learns, not just gets patched. You receive the file's code, its language, and the problems the editor already reports. Find EVERYTHING worth fixing and return ONLY a JSON object — no prose, no markdown fences — in this exact shape:
{
  "summary": "one-line overview of the file's health",
  "issues": [
    {
      "title": "short issue title",
      "line": 12,
      "type": "missing",
      "whatsWrong": "...",
      "whyItMatters": "...",
      "howToFix": "...",
      "fixedCode": "..."
    }
  ]
}
Cover three kinds of issues:
1. Reported problems — every editor diagnostic you are given (errors and warnings).
2. What's MISSING — missing imports, missing/undeclared variables, missing return values, missing await, missing error handling, missing null/undefined checks, missing dependencies, and unhandled edge cases.
3. Likely bugs or risky code the compiler won't flag.
Rules:
- type must be exactly one of: "error" | "warning" | "missing" | "suggestion". Use "error"/"warning" for reported diagnostics, "missing" for absent pieces, "suggestion" for risky-but-not-broken code.
- line: the 1-based line number when you can identify it; use 0 if it applies to the whole file or you can't pin it down.
- whatsWrong: plain English, what is wrong or missing. whyItMatters: the concrete consequence. howToFix: how to fix it.
- fixedCode: a minimal corrected snippet when it helps; use an empty string "" when a snippet wouldn't add anything.
- Teach: explain the why, don't just hand over a patch. Keep each field concise.
- If the file is genuinely healthy, return an empty "issues" array and a positive "summary".
Return only the JSON.`;

// JSON Schema kept simple (objects/strings/integer/enum/string-array) so it
// satisfies OpenAI strict mode (every field required, additionalProperties:false)
// and Gemini's dialect alike. ReviewSchema (Zod) is the final authority.
export const REVIEW_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          line: { type: "integer" },
          type: {
            type: "string",
            enum: ["error", "warning", "missing", "suggestion"],
          },
          whatsWrong: { type: "string" },
          whyItMatters: { type: "string" },
          howToFix: { type: "string" },
          fixedCode: { type: "string" },
        },
        required: [
          "title",
          "line",
          "type",
          "whatsWrong",
          "whyItMatters",
          "howToFix",
          "fixedCode",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "issues"],
  additionalProperties: false,
};

export interface ReviewInput {
  fileName: string;
  language: string;
  code: string;
  // Pre-formatted list of editor diagnostics, or a "none" line.
  diagnostics: string;
}

function buildUserMessage(input: ReviewInput): string {
  return [
    `FILE: ${input.fileName}`,
    `LANGUAGE: ${input.language}`,
    `EDITOR-REPORTED PROBLEMS:\n${input.diagnostics}`,
    `FILE CONTENTS:\n${input.code}`,
  ].join("\n\n");
}

// Reviews the file and returns the validated {summary, issues[]} result.
export async function reviewFile(
  provider: LLMProvider,
  opts: ProviderOptions,
  input: ReviewInput
): Promise<Review> {
  return runStructured(
    provider,
    opts,
    REVIEW_SYSTEM_PROMPT,
    buildUserMessage(input),
    REVIEW_JSON_SCHEMA,
    ReviewSchema,
    REVIEW_MAX_TOKENS
  );
}
