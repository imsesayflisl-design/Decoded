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
  howToAvoidNextTime: z.string(),
});

export type Explanation = z.infer<typeof ExplanationSchema>;
