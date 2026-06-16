import { z } from "zod";

// The exact four-part teaching shape Decoded expects back from the model.
// Order matters: it drives the words -> code -> words -> code rhythm.
export const ExplanationSchema = z.object({
  language: z.string(),
  whatItMeans: z.object({
    explanation: z.string(),
    relevantCode: z.string(),
  }),
  whyItsHappening: z.string(),
  howToFix: z.object({
    steps: z.array(z.string()),
    brokenCode: z.string(),
    correctedCode: z.string(),
  }),
  // The exact terminal command when the right fix is a command (e.g.
  // "npm install"), or "" when the fix is purely a code change. Lets the
  // four-part answer fix run/setup errors, not just in-file code.
  fixCommand: z.string().default(""),
  howToAvoidNextTime: z.string(),
});

export type Explanation = z.infer<typeof ExplanationSchema>;

// --- "Review File" — every issue in one file (Capability 1). ---
// All fields required (OpenAI strict mode); `line` is 0 when unknown and
// `fixedCode` is "" when a snippet wouldn't help — the panel hides them.
export const ReviewIssueSchema = z.object({
  title: z.string(),
  line: z.number(),
  type: z.enum(["error", "warning", "missing", "suggestion"]),
  whatsWrong: z.string(),
  whyItMatters: z.string(),
  howToFix: z.string(),
  fixedCode: z.string(),
});

export const ReviewSchema = z.object({
  summary: z.string(),
  issues: z.array(ReviewIssueSchema),
});

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type Review = z.infer<typeof ReviewSchema>;

// --- "Diagnose" — project/run/setup errors (Capability 2). ---
// `category` lets the flow fall back to the four-part explanation for a normal
// in-file code error; `fix.command` is "" when no single command applies.
export const DiagnosisSchema = z.object({
  category: z.enum(["setup", "code"]),
  diagnosis: z.string(),
  cause: z.string(),
  fix: z.object({
    steps: z.array(z.string()),
    command: z.string(),
    explanation: z.string(),
  }),
  preventNextTime: z.string(),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;
