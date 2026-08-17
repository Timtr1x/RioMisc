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
  compatProfile: z.enum(["AUTO", "OPENAI", "DEEPSEEK", "ZAI", "ANTHROPIC"]).optional(),
});

export const modelCapabilitiesSchema = z.object({
  text: z.boolean().optional(),
  toolCalling: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
});

export const modelCreateSchema = z.object({
  providerId: z.string(),
  modelName: z.string().min(1).max(200),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  maxOutputTokens: z.number().int().min(64).max(1_000_000),
  role: z.enum(["PRIMARY", "FALLBACK", "GENERAL"]).optional(),
  enabled: z.boolean().optional(),
  capabilities: modelCapabilitiesSchema.optional(),
});

export const modelPatchSchema = z
  .object({
    contextWindow: z.number().int().min(1024).max(10_000_000).optional(),
    maxOutputTokens: z.number().int().min(64).max(1_000_000).optional(),
  })
  .refine((v) => v.contextWindow !== undefined || v.maxOutputTokens !== undefined, {
    message: "contextWindow or maxOutputTokens required",
  });

export const modelAssignmentsSchema = z.object({
  primarySolverModelId: z.string().nullable().optional(),
  reflectionModelId: z.string().nullable().optional(),
  visionModelId: z.string().nullable().optional(),
  triageModelId: z.string().nullable().optional(),
  managerModelId: z.string().nullable().optional(),
});

export const reflectionModeSchema = z.enum(["OFF", "HEURISTIC", "LLM", "HYBRID"]);
export const managerModeSchema = z.enum(["OFF", "SHADOW", "ACTIVE"]);
export const manualDispatchSchema = z.enum(["AUTO", "FORCE_START", "FORCE_HOLD"]);
export const reflectionOverrideSchema = z.enum(["INHERIT", "ON", "OFF"]);
export const dispatchActionSchema = z.enum(["START", "HOLD", "CONTINUE"]);

export const challengeOrchestrationPatchSchema = z.object({
  strategyLocked: z.boolean().optional(),
  manualDispatch: manualDispatchSchema.optional(),
  reflectionOverride: reflectionOverrideSchema.optional(),
  reflectionModeOverride: reflectionModeSchema.nullable().optional(),
});

export const reflectionRunBodySchema = z.object({
  mode: reflectionModeSchema.optional(),
});

export const orchestrationSettingsPatchSchema = z.object({
  managerMode: managerModeSchema.optional(),
  managerEnabled: z.boolean().optional(),
});

export const llmReflectionResultSchema = z.object({
  diagnosis: z.string().min(1).max(1500),
  likelyMistakes: z.array(z.string().max(500)).max(8),
  missedEvidence: z.array(z.string().max(500)).max(8),
  recommendedNextSteps: z
    .array(
      z.object({
        action: z.string().min(1).max(400),
        reason: z.string().min(1).max(400),
        expectedSignal: z.string().min(1).max(400),
      }),
    )
    .max(6),
  shouldContinueCurrentDirection: z.boolean(),
  recommendHandoff: z.enum(["MISC", "CRYPTO"]).nullable(),
  confidence: z.number().min(0).max(1),
});

export const dispatchPlanSchema = z.object({
  summary: z.string().max(2000),
  decisions: z
    .array(
      z.object({
        challengeId: z.string().min(1).max(200),
        action: dispatchActionSchema,
        priority: z.number(),
        reflectionEnabled: z.boolean().nullable(),
        reason: z.string().max(500),
      }),
    )
    .max(80),
});

export const analyzeVisualParamsSchema = z.object({
  path: z.string().min(1).max(1000),
  question: z.string().max(4000).optional(),
  mode: z.enum(["AUTO", "LOCAL_ONLY", "VISION_MODEL"]).optional(),
  force: z.boolean().optional(),
});

export const requestVisualReviewParamsSchema = z.object({
  path: z.string().min(1).max(1000),
  question: z.string().min(1).max(4000),
  reason: z.string().min(1).max(4000),
});

export const renderSpectrogramParamsSchema = z.object({
  path: z.string().min(1).max(1000),
  mode: z.enum(["AUTO", "WIDE", "DETAIL"]).optional(),
  maxDurationSeconds: z.number().min(0.5).max(120).optional(),
});

export const extractKeyframesParamsSchema = z.object({
  path: z.string().min(1).max(1000),
  strategy: z.enum(["UNIFORM", "SCENE_CHANGE", "ALL_IF_SMALL"]).optional(),
  maxFrames: z.number().int().min(1).max(16).optional(),
});

export const visualReviewAnswerSchema = z.object({
  observation: z.string().min(1).max(4000),
  useful: z.boolean().optional(),
});

export const searchToolOutputParamsSchema = z.object({
  path: z.string().max(1000),
  query: z.string().min(1).max(200),
  maxMatches: z.number().int().min(1).max(200).optional(),
});

export const readToolOutputChunkParamsSchema = z.object({
  path: z.string().max(1000),
  offset: z.number().int().min(0).optional(),
  maxChars: z.number().int().min(100).max(100_000).optional(),
});

export const toolGroupSchema = z.enum([
  "WORKSPACE",
  "CONTROL",
  "MISC_FILE",
  "MISC_ARCHIVE",
  "MISC_IMAGE",
  "MISC_PCAP",
  "MISC_AUDIO_VIDEO",
  "CRYPTO_PARSE",
  "CRYPTO_RSA",
  "CRYPTO_NUMBER_THEORY",
  "CRYPTO_XOR_CLASSICAL",
  "CRYPTO_PRNG",
  "CRYPTO_SYMMETRIC",
  "CRYPTO_ADVANCED_MATH",
  "SPECIALIST",
]);

export const discoverToolsParamsSchema = z.object({
  query: z.string().max(400).optional(),
  group: toolGroupSchema.optional(),
  domain: z.enum(["MISC", "CRYPTO", "ANY"]).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

export const getToolHelpParamsSchema = z.object({
  name: z.string().min(1).max(80),
});

export const executeToolParamsSchema = z.object({
  name: z.string().min(1).max(80),
  args: z.record(z.unknown()).default({}),
});

/** Cryptographic integers must be strings — JSON numbers lose precision past 2^53. */
export const bigintStringSchema = z
  .string()
  .min(1)
  .max(20_000)
  .refine((s) => {
    const t = s.trim().replace(/[_ ,]/g, "");
    return /^(0x[0-9a-fA-F]+|\d+)$/.test(t);
  }, { message: "cryptographic integers must be decimal or 0x hex strings, not JSON numbers" });

const forceField = { force: z.boolean().optional() };

export const parseCryptoValuesSchema = z.object({
  text: z.string().max(50_000).optional(),
  path: z.string().max(1000).optional(),
  ...forceField,
}).refine((v) => Boolean(v.text || v.path), { message: "parse_crypto_values needs text or path" });

export const analyzeRsaInstanceSchema = z.object({
  text: z.string().max(50_000).optional(),
  path: z.string().max(1000).optional(),
  n: bigintStringSchema.optional(),
  e: bigintStringSchema.optional(),
  c: bigintStringSchema.optional(),
  ...forceField,
});

export const rsaSmallESchema = z.object({
  c: bigintStringSchema,
  e: bigintStringSchema,
  n: bigintStringSchema.optional(),
  ...forceField,
});

export const rsaFermatSchema = z.object({
  n: bigintStringSchema,
  ...forceField,
});

export const rsaWienerSchema = z.object({
  n: bigintStringSchema,
  e: bigintStringSchema,
  ...forceField,
});

export const rsaCommonModulusSchema = z.object({
  n: bigintStringSchema,
  e1: bigintStringSchema,
  c1: bigintStringSchema,
  e2: bigintStringSchema,
  c2: bigintStringSchema,
  ...forceField,
});

export const rsaHastadSchema = z.object({
  e: bigintStringSchema,
  n1: bigintStringSchema,
  c1: bigintStringSchema,
  n2: bigintStringSchema,
  c2: bigintStringSchema,
  n3: bigintStringSchema,
  c3: bigintStringSchema,
  ...forceField,
});

export const rsaBasicDecryptSchema = z.object({
  n: bigintStringSchema,
  c: bigintStringSchema,
  e: bigintStringSchema.optional(),
  p: bigintStringSchema.optional(),
  q: bigintStringSchema.optional(),
  ...forceField,
});

export const factorIntegerSchema = z.object({
  n: bigintStringSchema,
  ...forceField,
});

export const integerRootSchema = z.object({
  c: bigintStringSchema,
  e: bigintStringSchema,
  ...forceField,
});

export const modInverseSchema = z.object({
  a: bigintStringSchema,
  m: bigintStringSchema,
  ...forceField,
});

export const gcdSchema = z.object({
  a: bigintStringSchema,
  b: bigintStringSchema,
  ...forceField,
});

export const extendedGcdSchema = z.object({
  a: bigintStringSchema,
  b: bigintStringSchema,
  ...forceField,
});

export const crtSchema = z.object({
  a: bigintStringSchema,
  m: bigintStringSchema,
  b: bigintStringSchema,
  m2: bigintStringSchema,
  ...forceField,
});

export const linearCongruenceSchema = z.object({
  a: bigintStringSchema,
  b: bigintStringSchema,
  m: bigintStringSchema,
  ...forceField,
});

export const lcgRecoverSchema = z.object({
  samples: z.string().min(1).max(50_000),
  ...forceField,
});

export const aesInspectSchema = z.object({
  path: z.string().max(1000).optional(),
  text: z.string().max(50_000).optional(),
  ...forceField,
}).refine((v) => Boolean(v.path || v.text), { message: "aes_inspect needs path or HEX ciphertext in text" });

export const frequencyAnalysisSchema = z.object({
  text: z.string().max(50_000).optional(),
  path: z.string().max(1000).optional(),
  ...forceField,
}).refine((v) => Boolean(v.text || v.path), { message: "frequency_analysis needs text or path" });

export const xorBytesSchema = z.object({
  a: z.string().min(1).max(50_000),
  b: z.string().max(50_000).optional(),
  key: z.string().max(50_000).optional(),
  ...forceField,
}).refine((v) => Boolean(v.b || v.key), { message: "xor_bytes needs b or key (UTF-8). a is HEX data." });

export const xorKnownPlaintextSchema = z.object({
  c: z.string().min(1).max(50_000),
  p: z.string().max(50_000).optional(),
  m: z.string().max(50_000).optional(),
  ...forceField,
}).refine((v) => Boolean(v.p || v.m), { message: "xor_known_plaintext needs p or m (UTF-8 plaintext). c is HEX ciphertext." });

export const lllReduceSchema = z.object({
  matrix: z.string().min(1).max(100_000),
  ...forceField,
});

export const discreteLogSchema = z.object({
  g: bigintStringSchema,
  h: bigintStringSchema,
  m: bigintStringSchema,
  ...forceField,
});

export const pathOnlySchema = z.object({
  path: z.string().min(1).max(1000),
  force: z.boolean().optional(),
});

export const imageTransformSchema = z.object({
  path: z.string().min(1).max(1000),
  op: z.enum(["grayscale", "invert", "autocontrast", "threshold", "rotate90", "rotate180", "rotate270"]),
  force: z.boolean().optional(),
});

export const extractBitplaneSchema = z.object({
  path: z.string().min(1).max(1000),
  channel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.enum(["R", "G", "B", "A"])]),
  bit: z.number().int().min(0).max(7),
  force: z.boolean().optional(),
});

export const carveSchema = z.object({
  path: z.string().min(1).max(1000),
  offset: z.number().int().min(0),
  length: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
  destPath: z.string().max(1000).optional(),
  force: z.boolean().optional(),
});

export const cryptoTextSchema = z.object({
  text: z.string().max(50_000).optional(),
  path: z.string().max(1000).optional(),
  n: z.string().optional(),
  e: z.string().optional(),
  c: z.string().optional(),
  p: z.string().optional(),
  q: z.string().optional(),
  c1: z.string().optional(),
  c2: z.string().optional(),
  e1: z.string().optional(),
  e2: z.string().optional(),
  a: z.string().optional(),
  b: z.string().optional(),
  m: z.string().optional(),
  m2: z.string().optional(),
  samples: z.string().optional(),
  key: z.string().optional(),
  n1: z.string().optional(),
  n2: z.string().optional(),
  n3: z.string().optional(),
  c3: z.string().optional(),
  matrix: z.string().optional(),
  g: z.string().optional(),
  h: z.string().optional(),
  force: z.boolean().optional(),
});

export const specialistParamsSchema = z.object({
  kind: z.enum(["IMAGE", "PCAP", "AUDIO", "ARCHIVE", "RSA", "PRNG", "LATTICE"]),
  path: z.string().max(1000).optional(),
  text: z.string().max(50_000).optional(),
});

export const hypothesisParamsSchema = z.object({
  description: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(["CANDIDATE", "TESTING", "SUPPORTED", "REJECTED", "CONFIRMED"]).optional(),
  evidenceFor: z.array(z.string().max(1000)).max(20).optional(),
  evidenceAgainst: z.array(z.string().max(1000)).max(20).optional(),
  proposedTests: z
    .array(
      z.object({
        tool: z.string().max(80),
        args: z.unknown().optional(),
        expectedInformation: z.string().max(400).optional(),
        ifPositive: z.string().max(400).optional(),
        ifNegative: z.string().max(400).optional(),
        estimatedCost: z.enum(["CHEAP", "NORMAL", "EXPENSIVE"]).optional(),
      }),
    )
    .max(12)
    .optional(),
});

export type ReportProgressParams = z.infer<typeof reportProgressParamsSchema>;
export type SubmitFlagCandidateParams = z.infer<typeof submitFlagCandidateParamsSchema>;
export type RunPythonParams = z.infer<typeof runPythonParamsSchema>;
