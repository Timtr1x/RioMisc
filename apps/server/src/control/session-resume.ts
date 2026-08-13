// Decide whether the next worker should resume a persisted Pi session.
import { existsSync } from "node:fs";

export interface ResumableSessionLike {
  status: string;
  piSessionId: string | null;
  piSessionFile: string | null;
}

export function isResumableSession(session: ResumableSessionLike | null | undefined): boolean {
  if (!session) return false;
  if (session.status !== "INTERRUPTED" && session.status !== "PAUSED") return false;
  if (!session.piSessionFile) return false;
  // Mock persistence is not a Pi session file — never hand it to SessionManager.open.
  if (session.piSessionId?.startsWith("mock_") || /[/\\]mock-/.test(session.piSessionFile)) return false;
  return existsSync(session.piSessionFile);
}

export function buildResumeMessage(opts: {
  newHints?: string[];
  wrongFlags?: string[];
  revisionSummary?: string | null;
}): string {
  const hints = (opts.newHints ?? []).filter(Boolean);
  const wrong = (opts.wrongFlags ?? []).filter(Boolean);
  const parts = [
    "RECOVERY CONTINUATION",
    "",
    "The previous solver process was interrupted.",
    "",
    "Your persisted conversation and prior tool calls have been restored.",
    "",
    "Re-read challenge.txt because official hints, challenge updates or",
    "rejected submissions may have changed while you were offline.",
    "",
    "Continue from the existing reasoning state.",
  ];
  if (hints.length) {
    parts.push("", "NEW HINTS:", ...hints.map((h) => `- ${h}`));
  }
  if (wrong.length) {
    parts.push("", "REJECTED SUBMISSIONS (do not submit again):", ...wrong.map((f) => `- ${f}`));
  }
  if (opts.revisionSummary) {
    parts.push("", "CHALLENGE REVISION:", opts.revisionSummary);
  }
  return parts.join("\n");
}

export function kickoffLooksFresh(message: string): boolean {
  return /You are already inside this challenge's workspace/i.test(message) && /CHALLENGE:/i.test(message);
}

export function resumeLooksLikeContinuation(message: string): boolean {
  return /RECOVERY CONTINUATION/i.test(message) && !kickoffLooksFresh(message);
}
