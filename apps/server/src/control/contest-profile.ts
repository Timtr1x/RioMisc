// Persist the last Dashboard contest connection so a restart reconnects.
// Token/cookie stay in the encrypted SecretStore; SQLite only keeps non-secrets.
import type { Repositories } from "@rio/database";
import type { SecretStore } from "@rio/shared";
import { normalizeTrustedOrigins } from "@rio/contest";

export const CONTEST_PROFILE_KEY = "contest.profile";
export const CONTEST_TOKEN_REF = "contest.token";
export const CONTEST_COOKIE_REF = "contest.cookie";

export type PersistedContestKind = "idle" | "mock" | "ctfd";

export interface PersistedContestProfile {
  kind: PersistedContestKind;
  baseUrl: string | null;
  miscCryptoOnly: boolean;
  trustedCredentialOrigins: string[];
}

export interface LoadedContestProfile extends PersistedContestProfile {
  token: string | null;
  cookie: string | null;
}

function parseOrigins(raw: unknown): string[] {
  try {
    return normalizeTrustedOrigins(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return [];
  }
}

export function parseContestProfile(raw: string | null): PersistedContestProfile | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PersistedContestProfile> & Record<string, unknown>;
    if (v.kind !== "idle" && v.kind !== "mock" && v.kind !== "ctfd") return null;
    return {
      kind: v.kind,
      baseUrl: typeof v.baseUrl === "string" && v.baseUrl ? v.baseUrl : null,
      miscCryptoOnly: v.miscCryptoOnly !== false,
      trustedCredentialOrigins: parseOrigins(v.trustedCredentialOrigins),
    };
  } catch {
    return null;
  }
}

export async function loadContestProfile(repos: Repositories, secrets: SecretStore | null): Promise<LoadedContestProfile | null> {
  const parsed = parseContestProfile(repos.settings.get(CONTEST_PROFILE_KEY));
  if (!parsed) return null;
  const token = secrets ? ((await secrets.get(CONTEST_TOKEN_REF)) ?? null) : null;
  const cookie = secrets ? ((await secrets.get(CONTEST_COOKIE_REF)) ?? null) : null;
  return { ...parsed, token, cookie };
}

export async function saveContestProfile(
  repos: Repositories,
  secrets: SecretStore | null,
  profile: PersistedContestProfile,
  creds: { token?: string | null; cookie?: string | null } = {},
): Promise<void> {
  repos.settings.set(
    CONTEST_PROFILE_KEY,
    JSON.stringify({
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      miscCryptoOnly: profile.miscCryptoOnly,
      trustedCredentialOrigins: profile.trustedCredentialOrigins ?? [],
    } satisfies PersistedContestProfile),
  );
  if (!secrets?.hasMasterKey()) return;
  if (profile.kind === "idle") {
    await secrets.delete(CONTEST_TOKEN_REF);
    await secrets.delete(CONTEST_COOKIE_REF);
    return;
  }
  if (creds.token !== undefined) {
    if (creds.token) await secrets.set(CONTEST_TOKEN_REF, creds.token);
    else await secrets.delete(CONTEST_TOKEN_REF);
  }
  if (creds.cookie !== undefined) {
    if (creds.cookie) await secrets.set(CONTEST_COOKIE_REF, creds.cookie);
    else await secrets.delete(CONTEST_COOKIE_REF);
  }
}

export function profileLooksLikeSecretLeak(raw: string | null): boolean {
  if (!raw) return false;
  return /"token"\s*:|"cookie"\s*:/i.test(raw);
}
