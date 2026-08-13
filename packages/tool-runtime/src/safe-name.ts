// Untrusted remote attachment names → a basename that cannot escape workspace/input.

const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

const MAX_NAME_LEN = 180;

function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  return out;
}

function stripWindowsPrefix(s: string): string {
  let t = s.replaceAll("\\", "/");
  // UNC \\server\share\... or //server/share/...
  t = t.replace(/^\/{2,}[^/]+\/[^/]+\//, "");
  // drive letter C:/...
  t = t.replace(/^[a-zA-Z]:\//, "");
  return t;
}

function reservedStem(base: string): boolean {
  const stem = base.replace(/\.[^.]+$/, "");
  return WINDOWS_RESERVED.has(stem.toUpperCase()) || WINDOWS_RESERVED.has(base.toUpperCase());
}

import type { WorkspaceManager, WorkspaceLayout } from "./workspace.js";

/** Sanitize a remote attachment name. Disk name only — DB may keep the original. */
export function safeAttachmentFilename(original: string, attachmentId: string): string {
  const fallback = `attachment_${attachmentId.replace(/[^a-zA-Z0-9._-]/g, "_") || "file"}.bin`;
  let t = stripWindowsPrefix(String(original ?? ""));
  t = t.replaceAll("\\", "/");
  const parts = t.split("/");
  let base = parts[parts.length - 1] ?? "";
  base = stripControlChars(base).trim();
  if (!base || base === "." || base === "..") return fallback;
  if (base.endsWith(".") || base.endsWith(" ")) base = base.replace(/[.\s]+$/, "");
  if (!base || base === "." || base === "..") return fallback;
  if (reservedStem(base)) return fallback;
  if (base.length > MAX_NAME_LEN) {
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 && dot > base.length - 12 ? base.slice(dot) : "";
    base = base.slice(0, MAX_NAME_LEN - ext.length) + ext;
  }
  return base;
}

/** Disambiguate collisions in a single input/ directory (foo.zip, foo__2.zip, …). */
export function uniqueAttachmentFilename(safeName: string, used: Set<string>): string {
  const lower = safeName.toLowerCase();
  if (!used.has(lower)) {
    used.add(lower);
    return safeName;
  }
  const dot = safeName.lastIndexOf(".");
  const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
  const ext = dot > 0 ? safeName.slice(dot) : "";
  let n = 2;
  while (used.has(`${stem}__${n}${ext}`.toLowerCase())) n += 1;
  const next = `${stem}__${n}${ext}`;
  used.add(next.toLowerCase());
  return next;
}

/** Double-wrap: sanitize name then workspace.safeResolve(`input/${safe}`). */
export function resolveAttachmentTarget(
  workspace: WorkspaceManager,
  layout: WorkspaceLayout,
  originalName: string,
  attachmentId: string,
  used: Set<string>,
): { safeName: string; target: string } {
  const safeName = uniqueAttachmentFilename(safeAttachmentFilename(originalName, attachmentId), used);
  const target = workspace.safeResolve(layout.root, `input/${safeName}`);
  return { safeName, target };
}
