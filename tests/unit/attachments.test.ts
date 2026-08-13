// Attachment names must land under workspace/input or be rejected.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceManager, resolveAttachmentTarget, safeAttachmentFilename } from "@rio/tool-runtime";

describe("attachment name sanitize", () => {
  it("traversal / drive / UNC / reserved names land under workspace/input or are rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "rio-att-"));
    const wm = new WorkspaceManager(root);
    const layout = wm.ensure("ch1");
    const cases = [
      "../../evil.txt",
      "..\\..\\evil.txt",
      "C:\\Windows\\foo",
      "\\\\server\\share\\foo",
      "/etc/passwd",
      ".",
      "..",
      "CON",
      "NUL.txt",
      "foo/../../../bar",
    ];
    for (const name of cases) {
      const used = new Set<string>();
      try {
        const { target } = resolveAttachmentTarget(wm, layout, name, "att1", used);
        const norm = target.replaceAll("\\", "/").toLowerCase();
        const input = layout.input.replaceAll("\\", "/").toLowerCase();
        expect(norm.startsWith(input + "/") || norm === input).toBe(true);
        expect(norm.includes("/../")).toBe(false);
      } catch (e) {
        expect(String(e)).toMatch(/escape|denied|Unsafe/i);
      }
    }
    expect(safeAttachmentFilename("CON", "x")).toMatch(/^attachment_/);
    expect(safeAttachmentFilename(".", "y")).toMatch(/^attachment_/);
    rmSync(root, { recursive: true, force: true });
  });
});
