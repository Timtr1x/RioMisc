// Light Reflection (§66) — deterministic for MVP: consumes the latest progress
// report + wrong flags + hints and produces actionable guidance that gets
// injected back into the solver session.
import type { Repositories } from "@rio/database";
import type { Challenge } from "@rio/domain";
import type { EventBus } from "./bus.js";
import type { RioLogger } from "@rio/shared";

export interface ReflectionOutcome {
  diagnosis: string;
  likelyMistakes: string[];
  missedEvidence: string[];
  recommendedNextSteps: string[];
  shouldContinueCurrentDirection: boolean;
}

export function buildReflection(
  challenge: Challenge,
  latest: {
    summary: string;
    hypotheses: string[];
    confirmedFacts: string[];
    rejectedHypotheses: string[];
    nextActions: string[];
    confidence: number;
  } | null,
  wrongFlags: string[],
  hints: string[],
  experiments: string[] = [],
): ReflectionOutcome {
  const mistakes: string[] = [];
  const missed: string[] = [];
  const steps: string[] = [];
  let continueDir = true;

  if (wrongFlags.length >= 2) {
    mistakes.push("Multiple flags were rejected — the flag derivation itself is likely wrong, not just formatting.");
    steps.push("Re-derive from scratch: list every transformation applied to the raw data and validate each against the challenge description.");
    continueDir = false;
  }

  if (hints.length > 0) {
    steps.push(`Re-read the official hint(s) and map each sentence to a concrete test: ${hints.join(" | ")}`);
  }

  if (!latest || latest.confidence < 0.2) {
    mistakes.push("Confidence is very low — hypotheses may be guessed rather than evidence-driven.");
    missed.push("Evidence in the raw attachment (trailing data, metadata, channel anomalies) may have been skipped.");
    steps.push("Re-run inspect_file on every attachment and diff observed magic/entropy against assumptions.");
  } else {
    if (latest.hypotheses.length > 3) {
      mistakes.push("Too many concurrent hypotheses — pick the cheapest discriminating test between the top two.");
    }
    if (latest.confirmedFacts.length === 0) {
      missed.push("No confirmed facts recorded — treat earlier outputs as unverified.");
    }
  }

  const noSignal = experiments.filter((e) => e.endsWith("NO_SIGNAL")).length;
  if (noSignal >= 3) {
    mistakes.push("Three or more experiments returned NO_SIGNAL — stop repeating the same family of tests.");
    steps.push("Switch artifact or hypothesis; consult the experiment ledger before calling the same tool again.");
    continueDir = false;
  }
  if (experiments.some((e) => e.includes("ALREADY_TESTED"))) {
    mistakes.push("Repeated an already-tested experiment.");
  }

  if (steps.length === 0) {
    steps.push("Re-examine the problem statement for implicit constraints (format, key size, unusual words).");
  }

  return {
    diagnosis: `Reflection on "${challenge.title}": ${wrongFlags.length} rejected, ${hints.length} hint(s), confidence ${latest?.confidence ?? "?"}, facts ${latest?.confirmedFacts.length ?? 0}.`,
    likelyMistakes: mistakes,
    missedEvidence: missed,
    recommendedNextSteps: steps,
    shouldContinueCurrentDirection: continueDir,
  };
}

function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function reflectionMessage(outcome: ReflectionOutcome): string {
  const lines = [
    "REFLECTION PASS (control plane)",
    "",
    `Diagnosis: ${outcome.diagnosis}`,
    "",
  ];
  if (outcome.likelyMistakes.length) lines.push("Likely mistakes:", ...outcome.likelyMistakes.map((m) => `- ${m}`), "");
  if (outcome.missedEvidence.length) lines.push("Missed evidence:", ...outcome.missedEvidence.map((m) => `- ${m}`), "");
  lines.push("Recommended next steps:", ...outcome.recommendedNextSteps.map((s) => `- ${s}`), "");
  if (!outcome.shouldContinueCurrentDirection) {
    lines.push("Do not continue the current direction without first validating a core assumption.");
  }
  return lines.join("\n");
}

export class ReflectionService {
  constructor(
    private deps: {
      repos: Repositories;
      bus: EventBus;
      logger: RioLogger;
      inject: (challengeId: string, message: string) => boolean;
    },
  ) {}

  /** Run a reflection pass and inject the result into the solver. */
  reflect(challengeId: string, trigger: string): ReflectionOutcome & { injected: boolean } {
    const { repos } = this.deps;
    const challenge = repos.challenges.get(challengeId);
    if (!challenge) throw new Error("unknown challenge");
    const latest = repos.progress.latestForChallenge(challengeId);
    const wrongFlags = repos.submissions
      .listByChallenge(challengeId)
      .filter((s) => s.status === "WRONG")
      .map((s) => s.flagValue);
    const hints = repos.hints.listForChallenge(challengeId).map((h) => h.content);
    const experiments = repos.experiments.listByChallenge(challengeId);
    const outcome = buildReflection(
      challenge,
      latest
        ? {
            summary: latest.summary,
            hypotheses: safeJsonArray(latest.hypothesesJson),
            confirmedFacts: safeJsonArray(latest.confirmedFactsJson),
            rejectedHypotheses: safeJsonArray(latest.rejectedHypothesesJson),
            nextActions: safeJsonArray(latest.nextActionsJson),
            confidence: latest.confidence,
          }
        : null,
      wrongFlags,
      hints,
      experiments.map((e) => `${e.tool}:${e.outcome}`),
    );
    const injected = this.deps.inject(challengeId, reflectionMessage(outcome));
    const payload = { trigger, ...outcome, injected };
    repos.events.append("REFLECTION_RUN", challengeId, payload);
    this.deps.bus.publish({ type: "REFLECTION_RUN", challengeId, payload });
    this.deps.logger.info({ event: "reflection", challengeId, trigger, injected });
    return { ...outcome, injected };
  }
}
