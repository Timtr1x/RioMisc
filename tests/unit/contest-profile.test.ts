import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepositories } from "@rio/database";
import { FileSecretStore } from "@rio/shared";
import {
  CONTEST_PROFILE_KEY,
  loadContestProfile,
  parseContestProfile,
  profileLooksLikeSecretLeak,
  saveContestProfile,
} from "../../apps/server/src/control/contest-profile.ts";

describe("contest profile persistence", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function harness() {
    const dir = mkdtempSync(join(tmpdir(), "rio-prof-"));
    dirs.push(dir);
    const repos = createRepositories(join(dir, "t.sqlite"));
    const secrets = new FileSecretStore(join(dir, "secrets.enc"), "0".repeat(64));
    return { repos, secrets };
  }

  it("stores kind/url in settings and token only in the secret store", async () => {
    const { repos, secrets } = harness();
    await saveContestProfile(
      repos,
      secrets,
      { kind: "ctfd", baseUrl: "https://ctf.example.com", miscCryptoOnly: true },
      { token: "tok-secret", cookie: "sid=abc" },
    );
    const raw = repos.settings.get(CONTEST_PROFILE_KEY);
    expect(profileLooksLikeSecretLeak(raw)).toBe(false);
    expect(raw).toContain("ctf.example.com");
    expect(raw).not.toContain("tok-secret");
    expect(raw).not.toContain("sid=abc");
    const loaded = await loadContestProfile(repos, secrets);
    expect(loaded).toMatchObject({
      kind: "ctfd",
      baseUrl: "https://ctf.example.com",
      token: "tok-secret",
      cookie: "sid=abc",
    });
    repos.db.close();
  });

  it("disconnect persists idle and drops credentials", async () => {
    const { repos, secrets } = harness();
    await saveContestProfile(
      repos,
      secrets,
      { kind: "ctfd", baseUrl: "https://ctf.example.com", miscCryptoOnly: true },
      { token: "tok-secret" },
    );
    await saveContestProfile(repos, secrets, { kind: "idle", baseUrl: null, miscCryptoOnly: true });
    const loaded = await loadContestProfile(repos, secrets);
    expect(loaded?.kind).toBe("idle");
    expect(loaded?.token).toBeNull();
    repos.db.close();
  });

  it("empty token in a later save does not wipe a stored secret when omitted", async () => {
    const { repos, secrets } = harness();
    await saveContestProfile(
      repos,
      secrets,
      { kind: "ctfd", baseUrl: "https://ctf.example.com", miscCryptoOnly: true },
      { token: "keep-me" },
    );
    await saveContestProfile(repos, secrets, { kind: "ctfd", baseUrl: "https://ctf.example.com", miscCryptoOnly: true });
    expect((await loadContestProfile(repos, secrets))?.token).toBe("keep-me");
    await saveContestProfile(
      repos,
      secrets,
      { kind: "ctfd", baseUrl: "https://ctf.example.com", miscCryptoOnly: true },
      { token: "" },
    );
    expect((await loadContestProfile(repos, secrets))?.token).toBeNull();
    repos.db.close();
  });

  it("does not treat local / missing profile as a contest to restore", () => {
    expect(parseContestProfile(null)).toBeNull();
    expect(parseContestProfile(JSON.stringify({ kind: "local" }))).toBeNull();
  });
});
