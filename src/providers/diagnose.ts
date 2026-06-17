// "Diagnose" — handles project/run/setup errors (e.g. a missing node_modules
// causing "Cannot find module 'next'") and returns the exact fix command as
// structured JSON, validated by DiagnosisSchema. Reuses runStructured.
import { DiagnosisSchema, type Diagnosis } from "../schema";
import { runStructured } from "./explain";
import type { LLMProvider, ProviderOptions } from "./types";

// Diagnoses are short and focused.
const DIAGNOSE_MAX_TOKENS = 2000;

export const DIAGNOSE_SYSTEM_PROMPT = `You are Decoded, a patient senior engineer who fixes the errors that stop a project from RUNNING — setup, install, and environment problems — and teaches the developer along the way. You receive an error (often from a terminal) and a short summary of the project (package.json deps/scripts, whether node_modules exists, which lockfile/package manager is present). Return ONLY a JSON object — no prose, no markdown fences — in this exact shape:
{
  "category": "setup",
  "diagnosis": "plain-English statement of what is wrong / what is missing",
  "cause": "why it's happening in THIS project",
  "fix": {
    "steps": ["..."],
    "command": "the exact terminal command to run, e.g. npm install",
    "explanation": "what that command does"
  },
  "preventNextTime": "how to avoid this setup problem in future"
}
Detect setup/run/environment problems such as: dependencies not installed (node_modules missing) -> the install command; a specific missing package ("Cannot find module 'X'") -> identify X and give the install command; wrong/old Node version; missing environment variables; missing config files; a script that doesn't exist in package.json; port already in use; and similar.
Rules:
- category: "setup" for run/setup/environment/install problems. Use "code" ONLY if this is actually a normal in-file code/compile error (not a setup problem) — then keep the other fields brief; the editor will show a full code explanation instead.
- command: choose the package manager from the project's lockfile — package-lock.json -> npm, yarn.lock -> yarn, pnpm-lock.yaml -> pnpm (default to npm). For a missing package give the install command for that package (e.g. "npm install" to install everything, or "npm install <pkg>" for one). Use a single, exact, copy-pasteable command; use "" only if no single command applies.
- steps: short, ordered actions (e.g. ["Run npm install in the project root", "Then run npm run dev again"]).
- Teach: explain what the command does and why it was missing.
- LANGUAGE: Write for a beginner. Use short, everyday sentences and avoid jargon. If you must use a technical term, explain it in plain words right after (e.g. "node_modules — the folder that holds the code packages your project needs"). Talk like a patient friend, not a manual. Never assume prior knowledge.
Return only the JSON.`;

// Strict-mode-safe JSON Schema; DiagnosisSchema (Zod) is the final authority.
export const DIAGNOSE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["setup", "code"] },
    diagnosis: { type: "string" },
    cause: { type: "string" },
    fix: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "string" } },
        command: { type: "string" },
        explanation: { type: "string" },
      },
      required: ["steps", "command", "explanation"],
      additionalProperties: false,
    },
    preventNextTime: { type: "string" },
  },
  required: ["category", "diagnosis", "cause", "fix", "preventNextTime"],
  additionalProperties: false,
};

export interface DiagnoseInput {
  errorText: string;
  // Compact project summary from src/projectContext.ts.
  projectContext: string;
}

function buildUserMessage(input: DiagnoseInput): string {
  return [
    `ERROR / TERMINAL OUTPUT:\n${input.errorText}`,
    `PROJECT CONTEXT:\n${input.projectContext}`,
  ].join("\n\n");
}

// Diagnoses the error and returns the validated diagnosis result.
export async function diagnoseError(
  provider: LLMProvider,
  opts: ProviderOptions,
  input: DiagnoseInput
): Promise<Diagnosis> {
  return runStructured(
    provider,
    opts,
    DIAGNOSE_SYSTEM_PROMPT,
    buildUserMessage(input),
    DIAGNOSE_JSON_SCHEMA,
    DiagnosisSchema,
    DIAGNOSE_MAX_TOKENS
  );
}
