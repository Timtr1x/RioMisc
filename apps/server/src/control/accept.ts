// Drive any playable lifecycle into SOLVED for a human "Mark Correct".
import type { Repositories } from "@rio/database";
import type { StateMachine } from "../state-machine.js";

export function acceptIntoSolved(sm: StateMachine, repos: Repositories, challengeId: string, candidateId: string): void {
  const challenge = repos.challenges.get(challengeId);
  if (!challenge) throw new Error("unknown challenge");
  if (challenge.lifecycleStatus === "SOLVED") return;

  const status = () => repos.challenges.get(challengeId)!.lifecycleStatus;
  if (status() === "PAUSED" && !sm.transition(challengeId, "RESUME").allowed) {
    throw new Error("cannot accept candidate while PAUSED");
  }
  if (status() === "PARKED" && !sm.transition(challengeId, "UNPARK").allowed) {
    throw new Error("cannot accept candidate while PARKED");
  }
  if (status() === "READY") sm.transition(challengeId, "QUEUE");
  if (status() === "QUEUED" || status() === "ACTIVE") {
    sm.transition(challengeId, "CANDIDATE_FOUND", { payload: { candidateId } });
  }
  if (status() === "VERIFYING") sm.transition(challengeId, "VERIFY_OK", { payload: { candidateId } });
  if (status() === "SUBMITTING") {
    sm.transition(challengeId, "SUBMIT_CORRECT", { payload: { candidateId, manual: true } });
  }
  if (status() !== "SOLVED") {
    throw new Error(`cannot accept candidate while ${status()}`);
  }
}
