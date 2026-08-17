import { looksLikeCtfFlag } from "./submission.js";
import { normalizeFlagValue } from "./flag.js";

/** Pull flag-shaped tokens from a human visual-review answer. */
export function extractFlagsFromVisualObservation(observation: string): string[] {
  const trimmed = normalizeFlagValue(observation);
  if (!trimmed) return [];
  if (looksLikeCtfFlag(trimmed)) return [trimmed];
  const found = [...trimmed.matchAll(/[A-Za-z][A-Za-z0-9_-]{0,31}\{[^\r\n}\s]{1,400}\}/g)].map((m) => m[0]!);
  return [...new Set(found.map((f) => normalizeFlagValue(f)).filter((f) => looksLikeCtfFlag(f)))];
}

export function formatHumanVisualObservation(input: {
  sourcePath: string;
  question: string;
  observation: string;
  useful: boolean;
}): string {
  if (!input.useful) {
    return `HUMAN VISUAL OBSERVATION

Source:
${input.sourcePath}

Question:
${input.question}

Human observation:
No useful visual clue.

Treat this as externally supplied evidence. Do not keep asking the same visual question.`;
  }
  return `HUMAN VISUAL OBSERVATION

Source:
${input.sourcePath}

Question:
${input.question}

Human observation:
${input.observation}

Treat this as externally supplied evidence.`;
}
