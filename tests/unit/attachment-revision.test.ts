import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import { fingerprintRemote, syncRemoteChallenge } from "../../apps/server/src/control/challenge-sync.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RemoteChallenge } from "@rio/domain";

function remote(over: Partial<RemoteChallenge> & Pick<RemoteChallenge, "remoteId">): RemoteChallenge {
  return {
    title: "stego",
    description: "find it",
    category: "Misc",
    score: 100,
    solveCount: 3,
    createdAt: 1,
    updatedAt: 1,
    attachments: [{ remoteId: "file-1-0", name: "pic.jpg", url: "https://ctf.example.com/files/pic.jpg", sizeBytes: 10 }],
    ...over,
  };
}

describe("attachment revision", () => {
  let dir: string;
  let repos: ReturnType<typeof createRepositories>;
  let bus: EventBus;
  const events: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rio-rev-"));
    repos = createRepositories(join(dir, "t.sqlite"));
    bus = new EventBus();
    events.length = 0;
    bus.subscribe((e) => events.push(e.type));
  });

  afterEach(() => {
    repos.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hash includes attachments so a swapped file is a new revision", () => {
    const a = fingerprintRemote(remote({ remoteId: "1" }));
    const b = fingerprintRemote(remote({ remoteId: "1", attachments: [{ remoteId: "file-1-0", name: "pic.jpg", url: "https://ctf.example.com/files/pic-v2.jpg", sizeBytes: 20 }] }));
    const sameText = fingerprintRemote(remote({ remoteId: "1", description: "find it" }));
    expect(a.hash).toBe(sameText.hash);
    expect(a.hash).not.toBe(b.hash);
  });

  it("changed attachment is marked PENDING and emits CHALLENGE_ATTACHMENT_UPDATED", () => {
    const first = syncRemoteChallenge({ repos, remote: remote({ remoteId: "ctfd:x:1" }), bus });
    expect(first?.created).toBe(true);
    const att = repos.attachments.listByChallenge(first!.challengeId)[0]!;
    repos.attachments.update(att.id, { downloadStatus: "DOWNLOADED", localPath: "/tmp/pic.jpg", sha256: "abc" });

    const second = syncRemoteChallenge({
      repos,
      remote: remote({
        remoteId: "ctfd:x:1",
        attachments: [{ remoteId: "file-1-0", name: "pic.jpg", url: "https://ctf.example.com/files/pic-v2.jpg", sizeBytes: 99 }],
      }),
      bus,
    });
    expect(second?.attachmentChanged).toBe(true);
    expect(events).toContain("CHALLENGE_ATTACHMENT_UPDATED");
    const after = repos.attachments.listByChallenge(first!.challengeId)[0]!;
    expect(after.downloadStatus).toBe("PENDING");
    expect(after.remoteUrl).toContain("pic-v2.jpg");
    expect(after.sha256).toBeNull();

    const revs = repos.db.all<{ attachment_metas_json: string }>(
      "SELECT attachment_metas_json FROM challenge_revisions WHERE challenge_id = ?",
      first!.challengeId,
    );
    expect(revs.length).toBe(1);
    expect(revs[0]!.attachment_metas_json).toContain("pic-v2.jpg");
    expect(revs[0]!.attachment_metas_json).not.toBe("[]");
  });

  it("text-only change does not reset a downloaded attachment", () => {
    const first = syncRemoteChallenge({ repos, remote: remote({ remoteId: "ctfd:x:2" }), bus });
    const att = repos.attachments.listByChallenge(first!.challengeId)[0]!;
    repos.attachments.update(att.id, { downloadStatus: "DOWNLOADED", localPath: "/tmp/pic.jpg" });
    const second = syncRemoteChallenge({
      repos,
      remote: remote({ remoteId: "ctfd:x:2", description: "updated blurb" }),
      bus,
    });
    expect(second?.metadataChanged).toBe(true);
    expect(second?.attachmentChanged).toBe(false);
    expect(events).toContain("CHALLENGE_UPDATED");
    expect(events).not.toContain("CHALLENGE_ATTACHMENT_UPDATED");
    expect(repos.attachments.listByChallenge(first!.challengeId)[0]!.downloadStatus).toBe("DOWNLOADED");
  });
});
