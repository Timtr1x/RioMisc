// Zod schemas for every piece of external input that must be validated.
import { z } from "zod";

export const challengeCategorySchema = z.enum([
  "MISC",
  "CRYPTO",
  "WEB",
  "PWN",
  "REVERSE",
  "OTHER",
  "UNKNOWN",
]);

export const lifecycleStatusSchema = z.enum([
  "DISCOVERED",
  "PREPARING",
  "READY",
  "QUEUED",
  "ACTIVE",
  "VERIFYING",
  "SUBMITTING",
  "SOLVED",
  "PAUSED",
  "PARKED",
  "UNSUPPORTED",
  "ERROR",
]);

export const hintStatusSchema = z.enum([
  "NOT_SUPPORTED",
  "LOCKED",
  "ELIGIBLE",
  "FETCHING",
  "FETCHED",
  "DECLINED",
]);

export const progressStatusSchema = z.enum(["UNKNOWN", "ACTIVE", "STALLED"]);

export const startStatusSchema = z.enum([
  "NOT_REQUIRED",
  "NOT_STARTED",
  "STARTING",
  "STARTED",
  "FAILED",
]);

export const solverTypeSchema = z.enum(["MISC", "CRYPTO", "TRIAGE", "REFLECTION"]);

// --- Contest API responses (normalized by adapters before hitting this boundary) ---

export const remoteAttachmentSchema = z.object({
  remoteId: z.string().nullable(),
  name: z.string(),
  url: z.string().nullable(),
  sizeBytes: z.number().nullable(),
});

export const remoteChallengeSchema = z.object({
  remoteId: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  score: z.number().nullable(),
  solveCount: z.number().nullable(),
  createdAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
});

export const remoteChallengeDetailSchema = remoteChallengeSchema.extend({
  attachments: z.array(remoteAttachmentSchema),
});

// --- Agent tool params ---

export const reportProgressParamsSchema = z.object({
  summary: z.string().max(4000),
  hypotheses: z.array(z.string().max(1000)).max(20).optional(),
  confirmedFacts: z.array(z.string().max(1000)).max(20).optional(),
  rejectedHypotheses: z.array(z.string().max(1000)).max(20).optional(),
  nextActions: z.array(z.string().max(1000)).max(20).optional(),
  confidence: z.number().min(0).max(1),
  progress: z.enum(["SIGNIFICANT", "MINOR", "NONE"]).optional(),
  stalled: z.boolean().optional(),
});

export const submitFlagCandidateParamsSchema = z.object({
  value: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(4000),
  evidence: z
    .array(
      z.object({
        type: z.enum(["artifact", "script", "tool_output", "reason"]),
        path: z.string().max(1000).optional(),
        text: z.string().max(2000).optional(),
      }),
    )
    .max(20)
    .optional(),
});

export const requestHandoffParamsSchema = z.object({
  target: z.enum(["MISC", "CRYPTO"]),
  summary: z.string().max(4000),
});

export const requestReflectionParamsSchema = z.object({
  reason: z.string().max(1000),
});

export const runPythonParamsSchema = z.object({
  scriptPath: z.string().max(1000).optional(),
  code: z.string().max(512_000).optional(),
  args: z.array(z.string().max(4096)).max(64).optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
});

export const readFileParamsSchema = z.object({
  path: z.string().max(1000),
  maxChars: z.number().int().min(100).max(100000).optional(),
});

export const listWorkspaceParamsSchema = z.object({
  path: z.string().max(1000).optional(),
});

export const writeWorkFileParamsSchema = z.object({
  path: z.string().max(1000),
  content: z.string().max(100000),
});

export const inspectFileParamsSchema = z.object({
  path: z.string().max(1000),
});

export const extractArchiveParamsSchema = z.object({
  path: z.string().max(1000),
  destPath: z.string().max(1000).optional(),
  maxDepth: z.number().int().min(1).max(8).optional(),
});

// --- Control API bodies ---

export const setPriorityParamsSchema = z.object({
  priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]),
});

export const switchModelParamsSchema = z.object({
  modelId: z.string(),
});

export const manualCandidateParamsSchema = z.object({
  value: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().min(1).max(4000).optional(),
});

export const providerCreateSchema = z.object({
  displayName: z.string().min(1).max(200),
  protocol: z.enum([
    "OPENAI_CHAT_COMPLETIONS",
    "OPENAI_RESPONSES",
    "ANTHROPIC_MESSAGES",
  ]),
  baseUrl: z.string().url().max(1000),
  apiKey: z.string().min(1).max(2000),
  enabled: z.boolean().optional(),
});

export const modelCreateSchema = z.object({
  providerId: z.string(),
  modelName: z.string().min(1).max(200),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  maxOutputTokens: z.number().int().min(64).max(1_000_000),
  role: z.enum(["PRIMARY", "FALLBACK", "GENERAL"]).optional(),
  enabled: z.boolean().optional(),
});

export type ReportProgressParams = z.infer<typeof reportProgressParamsSchema>;
export type SubmitFlagCandidateParams = z.infer<typeof submitFlagCandidateParamsSchema>;
export type RunPythonParams = z.infer<typeof runPythonParamsSchema>;
