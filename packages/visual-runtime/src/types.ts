import type { VisualAnalyzer, VisualEvidence, VisualObservation } from "@rio/domain";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface ChannelStats {
  min: number;
  max: number;
  mean: number;
  variance: number;
}

export interface VisualOverview {
  width: number;
  height: number;
  mode: "RGBA";
  hasAlpha: boolean;
  alphaUsed: boolean;
  meanRgb: [number, number, number];
  channelVariance: [number, number, number, number];
  channels: { r: ChannelStats; g: ChannelStats; b: ChannelStats; a: ChannelStats };
  uniqueColorsEstimate: number;
  lowContrast: boolean;
  mostlyMonochrome: boolean;
  transparentPixelRatio: number;
  darkRatio: number;
  edgeDensity: number;
}

export type VisualMode = "AUTO" | "LOCAL_ONLY" | "VISION_MODEL";

export interface VisualAnalysisRequest {
  challengeId: string;
  path: string;
  question?: string;
  mode?: VisualMode;
  force?: boolean;
  budget?: {
    maxDerivedArtifacts?: number;
    allowVisionModel?: boolean;
  };
}

export interface DerivedVisualArtifact {
  relPath: string;
  absPath: string;
  operation: string;
}

export interface VisualAnalysisResult {
  ok: boolean;
  evidence: VisualEvidence;
  overview: VisualOverview | null;
  derived: DerivedVisualArtifact[];
  error?: string;
}

export interface QrHit {
  text: string;
  confidence: number;
  region?: { x: number; y: number; width: number; height: number };
}

export interface VisionModelAdapter {
  analyzeImage(input: {
    challengeId: string;
    path: string;
    image: RgbaImage;
    question: string;
    fileSha256?: string;
    force?: boolean;
  }): Promise<{ observations: VisualObservation[]; summary: string; confidence: number; analyzer: VisualAnalyzer; cached?: boolean; suggestedActions?: string[] }>;
}
