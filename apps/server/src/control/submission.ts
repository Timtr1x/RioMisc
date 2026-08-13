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
import { normalizeFlagValue } from "./flag.js";

/** Default: any `prefix{payload}` used by real CTFs (flag{}, FLAG{}, cumtctf{}, DASCTF{}, …). */
export const DEFAULT_FLAG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}\{[^\r\n}]{1,400}\}$/;

export function looksLikeCtfFlag(value: string, custom?: RegExp | null): boolean {
  const v = value.trim();
  if (custom) return custom.test(v);
  return DEFAULT_FLAG_PATTERN.test(v);
}

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
  /** Per-submission retry timers (RATE_LIMITED only). Never keyed only by challenge. */
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
      submitTimeoutMs?: number;
      flagPattern?: RegExp | null;
      inject: (challengeId: string, message: string) => void;
      onAutoSubmitDisabled: (challengeId: string) => void;
      onCorrect: (challengeId: string) => void;
    },
  ) {}

  replaceAdapter(adapter: ContestAdapter): void {
    this.deps.adapter = adapter;
  }

  cancelRetriesForChallenge(challengeId: string): void {
    for (const sub of this.deps.repos.submissions.listByChallenge(challengeId)) {
      const timer = this.retryTimers.get(sub.id);
      if (timer) {
        clearTimeout(timer);
        this.retryTimers.delete(sub.id);
      }
    }
  }

  /** Entry point for a candidate emitted by a worker. */
  async onCandidate(msg: CandidateMsg): Promise<void> {
    const { repos } = this.deps;
    const challenge = repos.challenges.get(msg.challengeId);
    if (!challenge || challenge.lifecycleStatus === "SOLVED") return;

    const value = normalizeFlagValue(msg.value);
    msg = { ...msg, value };

    // duplicate candidate?
    if (repos.candidates.existsByValue(challenge.id, value)) {
      this.deps.logger.info({ event: "candidate_duplicate", challengeId: challenge.id, flagHash: hashHex(value) });
      return;
    }

    const candidate = repos.candidates.create({
      challengeId: challenge.id,
      sessionId: msg.sessionId,
      value,
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

    const holdForHuman = !this.hasOfficialJudge(challenge);
    const shown = holdForHuman || willAutoSubmit ? "VERIFIED" : "PENDING";
    repos.candidates.update(candidate.id, { status: shown });
    this.deps.bus.publish({ type: "FLAG_CANDIDATE_FOUND", challengeId: challenge.id, payload: { candidateId: candidate.id, value: msg.value, confidence: msg.confidence, status: shown } });

    if (holdForHuman) {
      this.deps.logger.info({ event: "flag_needs_review", challengeId: challenge.id, candidateId: candidate.id }, "no official judge — waiting for human accept/reject");
      this.deps.bus.publish({ type: "FLAG_NEEDS_REVIEW", challengeId: challenge.id, payload: { candidateId: candidate.id, value: msg.value } });
      return;
    }
    if (willAutoSubmit) {
      this.deps.stateMachine.transition(challenge.id, "CANDIDATE_FOUND", { payload: { candidateId: candidate.id } });
      await this.submitCandidate(candidate, challenge);
    } else {
      this.deps.logger.info({ event: "candidate_pending", challengeId: challenge.id, candidateId: candidate.id, reason: autoDisabled ? "manual review required" : "below threshold" });
    }
  }

  /** Idle / URL-injected challenges have no contest judge. */
  hasOfficialJudge(challenge: Challenge): boolean {
    const adapter = this.deps.adapter as { kind: string; getFixtureFlag?: (id: string) => string | null };
    if (adapter.kind === "idle") return false;
    if (typeof adapter.getFixtureFlag === "function") {
      const known = adapter.getFixtureFlag(challenge.remoteId ?? "");
      if (known === "") return false;
    }
    return true;
  }

  /**
   * Re-run local verify on REJECTED_LOCAL candidates (e.g. after widening
   * the flag-format regex). Passing ones follow the normal auto-submit path.
   */
  async reconsiderRejectedLocal(challengeId: string): Promise<{ reconsidered: number; passed: number }> {
    const challenge = this.deps.repos.challenges.get(challengeId);
    if (!challenge || challenge.lifecycleStatus === "SOLVED") return { reconsidered: 0, passed: 0 };
    const rejected = this.deps.repos.candidates.listByChallenge(challengeId).filter((c) => c.status === "REJECTED_LOCAL");
    let passed = 0;
    for (const cand of rejected) {
      let evidence: { type: string; path?: string; text?: string }[] = [];
      try {
        evidence = JSON.parse(cand.evidenceJson) as { type: string; path?: string; text?: string }[];
      } catch {
        evidence = [];
      }
      const verify = this.verifyLocal(challenge, {
        challengeId,
        sessionId: cand.sessionId ?? "",
        value: cand.value,
        confidence: cand.confidence,
        reason: cand.reason,
        evidence,
      });
      if (!verify.pass) continue;
      passed += 1;
      const autoDisabled = challenge.blockedReason === "MANUAL_REVIEW_REQUIRED";
      const willAutoSubmit = this.deps.autoSubmit && cand.confidence >= this.deps.confidenceThreshold && !autoDisabled;
      this.deps.repos.candidates.update(cand.id, { status: willAutoSubmit ? "VERIFIED" : "PENDING" });
      this.deps.bus.publish({
        type: "FLAG_CANDIDATE_FOUND",
        challengeId,
        payload: { candidateId: cand.id, value: cand.value, confidence: cand.confidence, status: willAutoSubmit ? "VERIFIED" : "PENDING", reconsidered: true },
      });
      if (willAutoSubmit) {
        const fresh = this.deps.repos.challenges.get(challengeId);
        if (fresh && fresh.lifecycleStatus !== "SOLVED") {
          const ok = this.deps.stateMachine.transition(challengeId, "CANDIDATE_FOUND", { payload: { candidateId: cand.id } });
          if (ok.allowed) await this.submitCandidate(cand, fresh);
        }
      }
    }
    return { reconsidered: rejected.length, passed };
  }

  /** Local verifier (§73). */
  verifyLocal(challenge: Challenge, msg: CandidateMsg): { pass: boolean; reason: string } {
    const value = msg.value.trim();
    if (value.length === 0) return { pass: false, reason: "empty flag" };
    if (value.length > 500) return { pass: false, reason: "implausibly long flag" };
    if (/[\r\n]/.test(value)) return { pass: false, reason: "contains CR/LF" };
    if (!looksLikeCtfFlag(value, this.deps.flagPattern)) {
      return { pass: false, reason: `does not look like a CTF flag (expected prefix{payload}, got ${JSON.stringify(value.slice(0, 80))})` };
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
      const timeoutMs = this.deps.submitTimeoutMs ?? 30_000;
      result = await Promise.race([
        this.deps.adapter.submitFlag(challenge.remoteId ?? challenge.id, submission.flagValue),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error("submit timeout")), timeoutMs);
          t.unref();
        }),
      ]);
    } catch (e) {
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
        if (raw.needsManualReview || !this.hasOfficialJudge(challenge) || /unknown challenge/i.test(result.message ?? "")) {
          if (candidate) repos.candidates.update(candidate.id, { status: "VERIFIED" });
          this.deps.bus.publish({
            type: "FLAG_NEEDS_REVIEW",
            challengeId: challenge.id,
            payload: { candidateId: candidate?.id, flagHash: submission.flagHash, message: result.message },
          });
          this.deps.logger.info({ event: "flag_needs_review", challengeId: challenge.id, candidateId: candidate?.id }, "no official judge — candidate left for manual accept");
          this.deps.stateMachine.transition(challenge.id, "SUBMIT_WRONG", { payload: { reason: "no official judge" } });
          break;
        }
        this.#markOutcomeUnknown(challenge.id, submission.id, candidate?.id ?? null, result.message ?? "unknown");
        break;
      }
    }
  }

  /** Retry a RATE_LIMITED / cooldown submission. Never used for UNKNOWN. */
  scheduleRetry(challengeId: string, submissionId: string, waitMs: number): void {
    const existing = this.retryTimers.get(submissionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.retryTimers.delete(submissionId);
      const challenge = this.deps.repos.challenges.get(challengeId);
      const submission = this.deps.repos.submissions.get(submissionId);
      if (!challenge || !submission) return;
      if (challenge.lifecycleStatus !== "SUBMITTING") return;
      if (submission.status === "UNKNOWN") return;
      void this.#submitNow(challenge, submissionId);
    }, waitMs);
    timer.unref();
    this.retryTimers.set(submissionId, timer);
  }

  hasRetryTimer(submissionId: string): boolean {
    return this.retryTimers.has(submissionId);
  }

  retryTimerCount(): number {
    return this.retryTimers.size;
  }

  #markOutcomeUnknown(challengeId: string, submissionId: string, candidateId: string | null, message: string): void {
    const { repos } = this.deps;
    repos.submissions.update(submissionId, {
      status: "UNKNOWN",
      error: message,
      submittedAt: repos.submissions.get(submissionId)?.submittedAt ?? Date.now(),
    });
    if (candidateId) repos.candidates.update(candidateId, { status: "SUBMISSION_UNKNOWN", submittedAt: Date.now() });
    repos.challenges.update(challengeId, { blockedReason: "SUBMISSION_OUTCOME_UNKNOWN" });
    this.deps.bus.publish({
      type: "SUBMISSION_OUTCOME_UNKNOWN",
      challengeId,
      payload: { submissionId, flagHash: repos.submissions.get(submissionId)?.flagHash },
    });
    this.deps.logger.warn(
      { event: "submission_unknown", challengeId, submissionId },
      "automatic resubmission disabled; human reconciliation required",
    );
    this.deps.logger.warn(
      { event: "submission_retry_suppressed", challengeId, submissionId },
      "UNKNOWN outcome must not auto-retry",
    );
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

    if (!this.hasOfficialJudge(challenge)) {
      this.deps.logger.info({ event: "recovery_hold_for_review", challengeId }, "no official judge — not retrying submit");
      this.deps.stateMachine.transition(challengeId, "SUBMIT_WRONG", { payload: { reason: "no official judge" } });
      return;
    }

    const rows = this.deps.repos.submissions.listByChallenge(challengeId);

    // SENDING after crash → UNKNOWN. Never resend.
    const sending = rows.find((s) => s.status === "SENDING");
    if (sending) {
      this.#markOutcomeUnknown(challengeId, sending.id, sending.candidateId, "process restart while SENDING");
      return;
    }

    const unknown = rows.find((s) => s.status === "UNKNOWN");
    if (unknown) {
      this.deps.logger.warn(
        { event: "submission_retry_suppressed", challengeId, submissionId: unknown.id },
        "UNKNOWN submission left for human reconciliation",
      );
      this.deps.repos.challenges.update(challengeId, { blockedReason: "SUBMISSION_OUTCOME_UNKNOWN" });
      return;
    }

    // QUEUED and never sent may be driven.
    const queued = rows.find((s) => s.status === "QUEUED");
    if (queued) {
      this.deps.logger.info({ event: "recovery_requeue_submission", challengeId, submissionId: queued.id }, "driving queued submission");
      void this.#submitNow(challenge, queued.id);
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

    this.deps.stateMachine.transition(challengeId, "RECOVER_SUBMITTING", { payload: { reason: "recovery: no pending candidate" } });
  }

  /** Explicit human retry of an UNKNOWN / RATE_LIMITED submission. Never automatic. */
  async retrySubmission(challengeId: string, submissionId: string): Promise<void> {
    const challenge = this.deps.repos.challenges.get(challengeId);
    const submission = this.deps.repos.submissions.get(submissionId);
    if (!challenge || !submission) throw new Error("unknown challenge/submission");
    if (submission.challengeId !== challengeId) throw new Error("submission does not belong to this challenge");
    this.deps.repos.challenges.update(challengeId, { blockedReason: null });
    if (challenge.lifecycleStatus !== "SUBMITTING") {
      const toSubmit = this.deps.stateMachine.transition(challengeId, "CANDIDATE_FOUND", { payload: { submissionId } });
      if (toSubmit.allowed) {
        this.deps.stateMachine.transition(challengeId, "VERIFY_OK", { payload: { submissionId } });
      }
    }
    this.deps.repos.submissions.update(submissionId, { status: "QUEUED", error: null });
    const fresh = this.deps.repos.challenges.get(challengeId)!;
    await this.#submitNow(fresh, submissionId);
  }

  /** Human: give up on this submission and continue solving. */
  resumeSolvingAfterUnknown(challengeId: string): void {
    this.deps.repos.challenges.update(challengeId, { blockedReason: null });
    const res = this.deps.stateMachine.transition(challengeId, "RECOVER_SUBMITTING", {
      payload: { reason: "human resume after UNKNOWN" },
    });
    if (!res.allowed) {
      this.deps.stateMachine.transition(challengeId, "SUBMIT_WRONG", { payload: { reason: "human resume after UNKNOWN" } });
    }
  }

  stop(): void {
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }
}
