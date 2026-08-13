// Persist remote IDs the operator deleted so Poller does not recreate them.
import type { Repositories } from "@rio/database";

export const DELETED_REMOTE_IDS_KEY = "deletedRemoteIds";

export function loadDeletedRemoteIds(repos: Repositories): string[] {
  const raw = repos.settings.get(DELETED_REMOTE_IDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  } catch {
    return [];
  }
}

export function isDeletedRemoteId(repos: Repositories, remoteId: string | null | undefined): boolean {
  if (!remoteId) return false;
  return loadDeletedRemoteIds(repos).includes(remoteId);
}

export function rememberDeletedRemoteId(repos: Repositories, remoteId: string | null | undefined): void {
  if (!remoteId) return;
  const ids = loadDeletedRemoteIds(repos);
  if (ids.includes(remoteId)) return;
  ids.push(remoteId);
  repos.settings.set(DELETED_REMOTE_IDS_KEY, JSON.stringify(ids));
}
