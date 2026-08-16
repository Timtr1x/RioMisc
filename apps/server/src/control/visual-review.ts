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
