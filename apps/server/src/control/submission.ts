// SubmissionManager (§73-76): local verification, dedup, cooldown, wrong
// feedback, max-wrong policy. Solver never submits directly.
import type { RioLogger } from "@rio/shared";
import type { Repositories } from "@rio/database";
import type { Challenge, FlagCandidate, SubmissionResult } from "@rio/domain";
import type { ContestAdapter } from "@rio/contest";
import { ApiRateLimiter } from "@rio/contest";
import { hashHex } from "@rio/shared";
import type { EventBus } from "./bus.js";
import type { StateMachine } from "../state-machine.js";

const FLAG_PATTERN = /^flag\{[^}\n]+\}$/i;

export interface CandidateMsg {
  challengeId: string;
  sessionId: string;
  value: string;
  confidence: number;
  reason: string;
  evidence: { type: string; path?: string; text?: string }[];
}

export class SubmissionManager {
  private rateLimiter = new ApiRateLimiter();
  private retryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private deps: {
      repos: Repositories;
      adapter: ContestAdapter;
      stateMachine: StateMachine;
      bus: EventBus;
      logger: RioLogger;
      autoSubmit: boolean;
      confidenceThreshold: number;
      localMaxWrong: number;
      defaultCooldownMs: number;
      inject: (challengeId: string, message: string) => void;
      onAutoSubmitDisabled: (challengeId: string) => void;
      onCorrect: (challengeId: string) => void;
    },
  ) {}

  /** Entry point for a candidate emitted by a worker. */
  async onCandidate(msg: CandidateMsg): Promise<void> {
    const { repos } = this.deps;
    const challenge = repos.challenges.get(msg.challengeId);
    if (!challenge || challenge.lifecycleStatus === "SOLVED") return;

    // duplicate candidate?
    if (repos.candidates.existsByValue(challenge.id, msg.value)) {
      this.deps.logger.info({ event: "candidate_duplicate", challengeId: challenge.id, value: msg.value });
      return;
    }

    const candidate = repos.candidates.create({
      challengeId: challenge.id,
      sessionId: msg.sessionId,
      value: msg.value,
      confidence: msg.confidence,
      reason: msg.reason,
      evidenceJson: JSON.stringify(msg.evidence ?? []),
      status: "PENDING",
    });

    const verify = this.verifyLocal(challenge, msg);
    if (!verify.pass) {
      repos.candidates.update(candidate.id, { status: "REJECTED_LOCAL" });
      this.deps.bus.publish({ type: "FLAG_CANDIDATE_REJECTED", challengeId: challenge.id, payload: { candidateId: candidate.id, reason: verify.reason } });
      this.injectFeedback(challenge.id, `Local verification rejected candidate "${msg.value}": ${verify.reason}`);
      return;
    }

    const autoDisabled = challenge.blockedReason === "MANUAL_REVIEW_REQUIRED";
    const willAutoSubmit = this.deps.autoSubmit && msg.confidence >= this.deps.confidenceThreshold && !autoDisabled;

    repos.candidates.update(candidate.id, { status: willAutoSubmit ? "VERIFIED" : "PENDING" });
    this.deps.bus.publish({ type: "FLAG_CANDIDATE_FOUND", challengeId: challenge.id, payload: { candidateId: candidate.id, value: msg.value, confidence: msg.confidence, status: willAutoSubmit ? "VERIFIED" : "PENDING" } });

    if (willAutoSubmit) {
      this.deps.stateMachine.transition(challenge.id, "CANDIDATE_FOUND", { payload: { candidateId: candidate.id } });
      await this.submitCandidate(candidate, challenge);
    } else {
      this.deps.logger.info({ event: "candidate_pending", challengeId: challenge.id, candidateId: candidate.id, reason: autoDisabled ? "manual review required" : "below threshold" });
    }
  }

  /** Local verifier (§73). */
  verifyLocal(challenge: Challenge, msg: CandidateMsg): { pass: boolean; reason: string } {
    const value = msg.value.trim();
    if (value.length === 0) return { pass: false, reason: "empty flag" };
    if (value.length > 500) return { pass: false, reason: "implausibly long flag" };
    if (/[\r\n]/.test(value)) return { pass: false, reason: "contains CR/LF" };
    if (!FLAG_PATTERN.test(value)) {
      return { pass: false, reason: `does not match flag format ${FLAG_PATTERN}` };
    }
    if (!msg.reason || msg.reason.trim().length < 5) return { pass: false, reason: "missing justification (reason required)" };
    // example detection: candidate appears verbatim in description/hint without evidence
    const desc = `${challenge.description}`;
    const hints = this.deps.repos.hints.listForChallenge(challenge.id).map((h) => h.content).join("\n");
    if ((desc.includes(value) || hints.includes(value)) && !(msg.evidence ?? []).some((e) => e.type === "tool_output" || e.type === "artifact" || e.type === "script")) {
      return { pass: false, reason: "candidate appears in challenge text without derived evidence" };
    }
    return { pass: true, reason: "ok" };
  }

  /** Transition VERIFYING → SUBMITTING and perform the submission. */
  async submitCandidate(candidate: FlagCandidate, challenge: Challenge): Promise<void> {
    const { repos } = this.deps;
    const submission = repos.submissions.createOrGet({
      challengeId: challenge.id,
      candidateId: candidate.id,
      flagHash: hashHex(candidate.value),
      flagValue: candidate.value,
      status: "QUEUED",
    });
    const res = this.deps.stateMachine.transition(challenge.id, "VERIFY_OK", { payload: { candidateId: candidate.id, submissionId: submission.id } });
    if (!res.allowed) return;
    this.deps.bus.publish({ type: "SUBMISSION_QUEUED", challengeId: challenge.id, payload: { candidateId: candidate.id, flagHash: submission.flagHash } });
    await this.#submitNow(challenge, submission.id);
  }

  async manualSubmit(challengeId: string, candidateId: string): Promise<void> {
    const { repos } = this.deps;
    const candidate = repos.candidates.get(candidateId);
    const challenge = repos.challenges.get(challengeId);
    if (!candidate || !challenge) throw new Error("unknown candidate/challenge");
    if (candidate.status === "SUBMITTED" || candidate.status === "CORRECT" || candidate.status === "WRONG") {
      throw new Error(`candidate already ${candidate.status}`);
    }
    repos.candidates.update(candidate.id, { status: "VERIFIED" });
    const res = this.deps.stateMachine.transition(challengeId, "CANDIDATE_FOUND", { payload: { candidateId } });
    if (res.allowed) {
      await this.submitCandidate(candidate, challenge);
    } else {
      await this.submitCandidate(candidate, challenge);
    }
  }

  async #submitNow(challenge: Challenge, submissionId: string): Promise<void> {
    const { repos } = this.deps;
    const submission = repos.submissions.get(submissionId);
    if (!submission) return;

    // per-challenge cooldown
    const last = repos.submissions.lastByChallenge(challenge.id);
    const cooldown = this.deps.defaultCooldownMs;
    if (last && last.id !== submission.id && last.submittedAt) {
      const wait = last.submittedAt + cooldown - Date.now();
      if (wait > 0) {
        this.scheduleRetry(challenge.id, submission.id, wait);
        return;
      }
    }

    await this.rateLimiter.acquire("SUBMIT");
    repos.submissions.update(submission.id, { status: "SENDING" });
    this.deps.bus.publish({ type: "SUBMISSION_SENT", challengeId: challenge.id, payload: { submissionId: submission.id, flagHash: submission.flagHash } });

    let result: SubmissionResult;
    try {
      result = await this.deps.adapter.submitFlag(challenge.remoteId ?? challenge.id, submission.flagValue);
    } catch (e) {
      // network error / timeout → outcome UNKNOWN; do not resubmit blindly
      result = { ok: false, correct: false, status: "UNKNOWN", message: String(e), raw: {} };
    }

    repos.submissions.update(submission.id, {
      status: result.status === "CORRECT" ? "CORRECT" : result.status === "WRONG" ? "WRONG" : result.status === "RATE_LIMITED" ? "RATE_LIMITED" : "UNKNOWN",
      remoteResponseJson: JSON.stringify(result.raw ?? {}),
      error: result.message ?? null,
      submittedAt: Date.now(),
    });

    const candidate = submission.candidateId ? repos.candidates.get(submission.candidateId) : null;

    switch (result.status) {
      case "CORRECT": {
        if (candidate) repos.candidates.update(candidate.id, { status: "CORRECT", submittedAt: Date.now() });
        repos.challenges.update(challenge.id, { wrongSubmissionCount: repos.submissions.countWrong(challenge.id) });
        this.deps.bus.publish({ type: "SUBMISSION_CORRECT", challengeId: challenge.id, payload: { submissionId: submission.id, flagHash: submission.flagHash } });
        this.deps.stateMachine.transition(challenge.id, "SUBMIT_CORRECT", { payload: { submissionId: submission.id } });
        this.deps.onCorrect(challenge.id);
        break;
      }
      case "WRONG": {
        if (candidate) repos.candidates.update(candidate.id, { status: "WRONG", submittedAt: Date.now() });
        const wrongCount = repos.submissions.countWrong(challenge.id);
        repos.challenges.update(challenge.id, { wrongSubmissionCount: wrongCount });
        this.deps.bus.publish({ type: "SUBMISSION_WRONG", challengeId: challenge.id, payload: { submissionId: submission.id, flagHash: submission.flagHash, wrongCount } });
        this.deps.stateMachine.transition(challenge.id, "SUBMIT_WRONG", { payload: { submissionId: submission.id, wrongCount } });
        this.injectFeedback(challenge.id, submission.flagValue);
        if (wrongCount >= this.deps.localMaxWrong) {
          repos.challenges.update(challenge.id, { blockedReason: "MANUAL_REVIEW_REQUIRED" });
          this.deps.bus.publish({ type: "AUTO_SUBMIT_DISABLED", challengeId: challenge.id, payload: { wrongCount } });
          this.deps.onAutoSubmitDisabled(challenge.id);
        }
        break;
      }
      case "RATE_LIMITED": {
        if (candidate) repos.candidates.update(candidate.id, { status: "SUBMITTED", submittedAt: Date.now() });
        this.deps.bus.publish({ type: "SUBMISSION_RATE_LIMITED", challengeId: challenge.id, payload: { submissionId: submission.id, cooldownMs: result.cooldownMs } });
        const wait = Math.max(result.cooldownMs ?? 10_000, 10_000);
        this.scheduleRetry(challenge.id, submission.id, wait);
        break;
      }
      case "UNKNOWN":
      case "ERROR":
      default: {
        const raw = (result.raw ?? {}) as { needsManualReview?: boolean };
        if (raw.needsManualReview) {
          // URL / idle tasks have no official judge — keep the candidate for the dashboard.
          if (candidate) repos.candidates.update(candidate.id, { status: "VERIFIED" });
          this.deps.bus.publish({
            type: "FLAG_NEEDS_REVIEW",
            challengeId: challenge.id,
            payload: { candidateId: candidate?.id, value: submission.flagValue, message: result.message },
          });
          this.deps.logger.info({ event: "flag_needs_review", challengeId: challenge.id, candidateId: candidate?.id }, "no official judge — candidate left for manual accept");
          this.deps.stateMachine.transition(challenge.id, "SUBMIT_WRONG", { payload: { reason: "no official judge" } });
          break;
        }
        if (candidate) repos.candidates.update(candidate.id, { status: "SUBMISSION_UNKNOWN", submittedAt: Date.now() });
        this.deps.bus.publish({ type: "SUBMISSION_ERROR", challengeId: challenge.id, payload: { submissionId: submission.id, message: result.message } });
        this.deps.logger.warn({ event: "submission_unknown", challengeId: challenge.id, submissionId: submission.id, message: result.message }, "submission outcome unknown");
        this.scheduleRetry(challenge.id, submission.id, 60_000);
        break;
      }
    }
  }

  /** Retry a submission after a delay (cooldown / rate limit / unknown outcome). */
  scheduleRetry(challengeId: string, submissionId: string, waitMs: number): void {
    const existing = this.retryTimers.get(challengeId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.retryTimers.delete(challengeId);
      const challenge = this.deps.repos.challenges.get(challengeId);
      const submission = this.deps.repos.submissions.get(submissionId);
      if (!challenge || !submission) return;
      if (challenge.lifecycleStatus !== "SUBMITTING") return;
      void this.#submitNow(challenge, submissionId);
    }, waitMs);
    timer.unref();
    this.retryTimers.set(challengeId, timer);
  }

  injectFeedback(challengeId: string, flagValue: string): void {
    const msg = `OFFICIAL SUBMISSION FEEDBACK

The following candidate was rejected by the official judge:

<${flagValue}>

Do not submit this exact candidate again.

Re-evaluate the derivation that produced it.
Treat the rejection as negative evidence.`;
    this.deps.inject(challengeId, msg);
  }

  /** Called during recovery: re-drive a stuck SUBMITTING challenge. */
  async recoverSubmitting(challengeId: string): Promise<void> {
    const challenge = this.deps.repos.challenges.get(challengeId);
    if (!challenge || challenge.lifecycleStatus !== "SUBMITTING") return;

    // 1. a submission was sent but its outcome is unknown → resubmit once
    const unknown = this.deps.repos.submissions.findUnknownOutcome(challengeId);
    if (unknown) {
      this.deps.logger.info({ event: "recovery_resubmit", challengeId }, "resubmitting unknown-outcome submission");
      this.deps.repos.submissions.update(unknown.id, { status: "SENDING" });
      this.scheduleRetry(challengeId, unknown.id, 5_000);
      return;
    }

    // 2. a submission was queued but never sent → drive it
    const queued = this.deps.repos.submissions
      .listByChallenge(challengeId)
      .find((s) => s.status === "QUEUED" || s.status === "SENDING");
    if (queued) {
      this.deps.logger.info({ event: "recovery_requeue_submission", challengeId }, "driving queued submission");
      this.deps.repos.submissions.update(queued.id, { status: "SENDING" });
      this.scheduleRetry(challengeId, queued.id, 1_000);
      return;
    }

    // 3. a verified candidate was never submitted → submit it
    const candidate = this.deps.repos.candidates
      .listByChallenge(challengeId)
      .find((c) => c.status === "VERIFIED" || c.status === "PENDING");
    if (candidate) {
      this.deps.repos.candidates.update(candidate.id, { status: "VERIFIED" });
      const submission = this.deps.repos.submissions.createOrGet({
        challengeId,
        candidateId: candidate.id,
        flagHash: hashHex(candidate.value),
        flagValue: candidate.value,
        status: "QUEUED",
      });
      this.deps.logger.info({ event: "recovery_submit_candidate", challengeId, candidateId: candidate.id }, "submitting preserved candidate");
      this.scheduleRetry(challengeId, submission.id, 1_000);
      return;
    }

    // 4. nothing pending → back to ACTIVE (solver continues)
    this.deps.stateMachine.transition(challengeId, "SUBMIT_WRONG", { payload: { reason: "recovery: no pending candidate" } });
  }

  stop(): void {
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }
}
