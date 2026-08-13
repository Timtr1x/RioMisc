import { describe, it, expect, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { WorkspaceManager } from "@rio/tool-runtime";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedChallenge } from "../helpers.ts";
import {
  isDeletedRemoteId,
  rememberDeletedRemoteId,
  loadDeletedRemoteIds,
} from "../../apps/server/src/control/deleted.ts";

describe("challenge delete", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tmp() {
    const dir = mkdtempSync(join(tmpdir(), "rio-del-"));
    dirs.push(dir);
    return dir;
  }

  it("cascades related rows and forgets the remote id", () => {
    const dir = tmp();
    const repos = createRepositories(join(dir, "t.sqlite"));
    repos.challenges.create(seedChallenge({ id: "ch_x", remoteId: "url_demo", lifecycleStatus: "SOLVED" }));
    repos.attachments.create({
      challengeId: "ch_x",
      remoteId: null,
      name: "a.bin",
      remoteUrl: null,
      localPath: null,
      sizeBytes: 1,
      sha256: null,
      mime: null,
      downloadStatus: "DOWNLOADED",
      downloadedAt: Date.now(),
    });
    repos.candidates.create({
      challengeId: "ch_x",
      sessionId: null,
      value: "flag{x}",
      confidence: 0.9,
      reason: "test",
      evidenceJson: "[]",
      status: "CORRECT",
    });
    repos.events.append("CHALLENGE_DISCOVERED", "ch_x", { title: "x" });

    rememberDeletedRemoteId(repos, "url_demo");
    repos.challenges.deleteCascade("ch_x");

    expect(repos.challenges.get("ch_x")).toBeNull();
    expect(repos.attachments.listByChallenge("ch_x")).toHaveLength(0);
    expect(repos.candidates.listByChallenge("ch_x")).toHaveLength(0);
    expect(repos.events.recent("ch_x", 10)).toHaveLength(0);
    expect(isDeletedRemoteId(repos, "url_demo")).toBe(true);
    expect(loadDeletedRemoteIds(repos)).toContain("url_demo");
    repos.db.close();
  });

  it("workspace.remove only deletes that challenge dir", () => {
    const dir = tmp();
    const ws = new WorkspaceManager(join(dir, "workspaces"));
    const layout = ws.ensure("ch_keep");
    const gone = ws.ensure("ch_gone");
    writeFileSync(join(gone.input, "f.txt"), "x");
    writeFileSync(join(layout.input, "keep.txt"), "y");
    ws.remove("ch_gone");
    expect(existsSync(gone.root)).toBe(false);
    expect(existsSync(join(layout.input, "keep.txt"))).toBe(true);
  });
});
