import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VisualEvidence, VisualObservation } from "@rio/domain";
import { decodeImageFile } from "./decode.js";
import { computeVisualOverview } from "./local/overview.js";
import { decodeQr } from "./local/qr.js";
import { renderChannelsContactSheet } from "./local/channels.js";
import { renderBitplanesContactSheet } from "./local/bitplanes.js";
import type { DerivedVisualArtifact, VisualAnalysisRequest, VisualAnalysisResult, VisionModelAdapter } from "./types.js";

export class VisualRuntime {
  constructor(
    private opts: {
      vision?: VisionModelAdapter | null;
      /** When set, vision was requested/configured but cannot run (e.g. text-only model). */
      unavailableReason?: string | null;
    } = {},
  ) {}

  async analyze(req: VisualAnalysisRequest, absPath: string, artifactDir: string): Promise<VisualAnalysisResult> {
    const derived: DerivedVisualArtifact[] = [];
    const budget = req.budget?.maxDerivedArtifacts ?? 4;
    let image;
    try {
      image = decodeImageFile(absPath);
    } catch (e) {
      const evidence = makeEvidence(req, {
        summary: `not a readable image: ${(e as Error).message}`,
        observations: [],
        confidence: 0,
        analyzer: "LOCAL",
      });
      return { ok: false, evidence, overview: null, derived, error: (e as Error).message };
    }

    const overview = computeVisualOverview(image);
    const observations: VisualObservation[] = [
      {
        type: "STRUCTURE",
        description: `${overview.width}x${overview.height} ${overview.mode}; unique≈${overview.uniqueColorsEstimate}; lowContrast=${overview.lowContrast}; mono=${overview.mostlyMonochrome}`,
        confidence: 1,
      },
    ];

    const qrs = decodeQr(image);
    for (const qr of qrs) {
      observations.push({
        type: "QR",
        value: qr.text,
        description: `QR decoded: ${qr.text}`,
        region: qr.region,
        confidence: qr.confidence,
      });
    }

    if (qrs.length === 0 && budget >= 2) {
      const channelsAbs = join(artifactDir, "channels-contact-sheet.png");
      renderChannelsContactSheet(image, channelsAbs);
      derived.push({ relPath: relFrom(artifactDir, channelsAbs), absPath: channelsAbs, operation: "render_channels" });
      const bitsAbs = join(artifactDir, "bitplanes-contact-sheet.png");
      renderBitplanesContactSheet(image, bitsAbs);
      derived.push({ relPath: relFrom(artifactDir, bitsAbs), absPath: bitsAbs, operation: "render_bitplanes" });
      observations.push({
        type: "PATTERN",
        description: "No QR in original. Wrote channel and bitplane contact sheets for inspection.",
        confidence: 0.6,
      });
    }

    const mode = req.mode ?? "AUTO";
    const wantsVision =
      mode === "VISION_MODEL" || (mode === "AUTO" && qrs.length === 0 && req.budget?.allowVisionModel !== false);
    const unavailable = this.opts.unavailableReason?.trim() || null;

    if (mode !== "LOCAL_ONLY" && qrs.length === 0 && wantsVision) {
      if (this.opts.vision) {
        try {
          const question = req.question?.trim();
          if (!question) {
            observations.push({
              type: "OTHER",
              description: "Vision skipped: provide a specific question (do not ask to describe the image).",
              confidence: 0.3,
            });
          } else {
            const vis = await this.opts.vision.analyzeImage({
              challengeId: req.challengeId,
              path: req.path,
              image,
              question,
              force: req.force,
            });
            observations.push(...vis.observations);
            const evidence = makeEvidence(req, {
              summary: vis.summary,
              observations,
              confidence: vis.confidence,
              analyzer: vis.analyzer,
            });
            writeEvidenceJson(artifactDir, evidence);
            return { ok: true, evidence, overview, derived };
          }
        } catch (e) {
          observations.push({
            type: "OTHER",
            description: `vision model unavailable: ${(e as Error).message}`,
            confidence: 0.2,
          });
        }
      } else if (unavailable || mode === "VISION_MODEL") {
        const reason =
          unavailable ?? "Vision model feature unavailable: no vision-capable model is configured.";
        observations.push({
          type: "OTHER",
          description: reason,
          confidence: 0.2,
        });
        if (mode === "VISION_MODEL") {
          const evidence = makeEvidence(req, {
            summary: reason,
            observations,
            confidence: 0.1,
            analyzer: "LOCAL",
          });
          writeEvidenceJson(artifactDir, evidence);
          return { ok: false, evidence, overview, derived, error: reason };
        }
      }
    } else if (mode === "AUTO" && qrs.length === 0 && !this.opts.vision && unavailable) {
      // Assigned a non-vision model: local path still runs, but Solver must see why remote vision did not.
      observations.push({
        type: "OTHER",
        description: unavailable,
        confidence: 0.2,
      });
    }

    const summary = qrs.length
      ? `Local visual analysis found ${qrs.length} QR: ${qrs.map((q) => q.text).join(" | ")}`
      : `Local visual analysis ${overview.width}x${overview.height}; no QR. Contact sheets generated.`;
    const evidence = makeEvidence(req, {
      summary,
      observations,
      confidence: qrs.length ? 0.95 : 0.55,
      analyzer: "LOCAL",
    });
    writeEvidenceJson(artifactDir, evidence);
    return { ok: true, evidence, overview, derived };
  }
}

function makeEvidence(
  req: VisualAnalysisRequest,
  parts: Pick<VisualEvidence, "summary" | "observations" | "confidence" | "analyzer">,
): VisualEvidence {
  return {
    id: `ve_${Math.random().toString(36).slice(2, 14)}`,
    challengeId: req.challengeId,
    sourceArtifactId: null,
    sourcePath: req.path,
    sourceType: "IMAGE",
    question: req.question ?? null,
    analyzer: parts.analyzer,
    observations: parts.observations,
    summary: parts.summary,
    confidence: parts.confidence,
    createdAt: Date.now(),
  };
}

function writeEvidenceJson(artifactDir: string, evidence: VisualEvidence): void {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, `${evidence.id}.json`), JSON.stringify(evidence, null, 2), "utf8");
}

function relFrom(dir: string, abs: string): string {
  return abs.slice(dirname(dir).length + 1).replaceAll("\\", "/");
}
