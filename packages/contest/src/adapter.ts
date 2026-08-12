// ContestAdapter — the single abstraction over a CTF competition API.
import type {
  ContestCapabilities,
  RemoteChallenge,
  RemoteChallengeDetail,
  StartChallengeResult,
  HintResult,
  SubmissionResult,
  DownloadResult,
} from "@rio/domain";

export interface ContestAdapter {
  readonly kind: string;

  getCapabilities(): Promise<ContestCapabilities>;

  authenticate(): Promise<void>;

  listChallenges(): Promise<RemoteChallenge[]>;

  getChallenge(remoteId: string): Promise<RemoteChallengeDetail>;

  /** Optional — contests without dynamic start return NOT_REQUIRED. */
  startChallenge?(remoteId: string): Promise<StartChallengeResult>;

  downloadAttachment(
    challenge: RemoteChallengeDetail,
    attachment: { remoteId: string | null; name: string; url: string | null },
    sink: import("node:stream").Writable,
  ): Promise<DownloadResult>;

  getHint?(remoteId: string): Promise<HintResult>;

  submitFlag(remoteId: string, flag: string): Promise<SubmissionResult>;
}
