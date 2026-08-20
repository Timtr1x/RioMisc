// Runtime configuration (config/runtime.yaml) with strict Zod validation.
// Invalid config must fail startup loudly — never silently use dangerous defaults.
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import type { StartPolicy } from "@rio/domain";

export const runtimeConfigSchema = z.object({
  contest: z.object({
    adapter: z.enum(["mock", "local", "none", "ctfd", "dasctf"]).default("mock"),
    /** Path to a MockContest scenario JSON file (optional; defaults to built-in fixtures). */
    mockScenario: z.string().nullable().default(null),
    localChallengeDir: z.string().nullable().default(null),
    /** Contest base URL when adapter is ctfd/dasctf (also settable at runtime via Dashboard). */
    baseUrl: z.string().nullable().default(null),
    /** CTFd Token or DASCTF X-Agent-AccessKey (prefer env / Dashboard SecretStore). */
    token: z.string().nullable().default(null),
    cookie: z.string().nullable().default(null),
    /** When true, only ingest Misc / Crypto (and 杂项 / 密码). */
    miscCryptoOnly: z.boolean().default(true),
    /** Extra origins that may receive Token/Cookie/AccessKey (e.g. files CDN). */
    trustedCredentialOrigins: z.array(z.string().min(1)).default([]),
    poll: z.object({
      initialMs: z.number().int().min(1000).max(60000).default(5000),
      maxMs: z.number().int().min(1000).max(60000).default(15000),
      backoffFactor: z.number().min(1.0).max(3.0).default(1.4),
      cooldownAfterChangeMs: z.number().int().min(1000).max(60000).default(5000),
    }).default({}),
  }).default({}),

  challenge: z.object({
    startPolicy: z.enum(["ON_DISCOVERY", "ON_PREPARATION", "ON_SOLVER_ASSIGNMENT"]).default("ON_SOLVER_ASSIGNMENT"),
  }).default({}),

  hint: z.object({
    autoFetch: z.boolean().default(true),
    requireStalled: z.boolean().default(true),
    eligibleAfterStartMs: z.number().int().min(0).default(600_000), // 10 min
    stallThresholdMs: z.number().int().min(0).default(300_000), // 5 min stalled before hint
  }).default({}),

  submission: z.object({
    autoSubmit: z.boolean().default(true),
    confidenceThreshold: z.number().min(0).max(1).default(0.85),
    localMaxWrong: z.number().int().min(0).max(50).default(10),
    defaultCooldownMs: z.number().int().min(0).default(60_000),
    /** Optional override. Default accepts prefix{payload} (flag{}, cumtctf{}, DASCTF{}, …). */
    flagPattern: z.string().min(1).max(400).nullable().default(null),
  }).default({}),

  workers: z.object({
    solverConcurrency: z.number().int().min(1).max(16).default(4),
    triageConcurrency: z.number().int().min(1).max(16).default(4),
  }).default({}),

  resources: z.object({
    llm: z.number().int().min(1).max(64).default(6),
    cpuLight: z.number().int().min(1).max(64).default(4),
    cpuHeavy: z.number().int().min(0).max(16).default(1),
    memHeavy: z.number().int().min(0).max(16).default(1),
    diskHeavy: z.number().int().min(0).max(16).default(1),
    network: z.number().int().min(1).max(64).default(4),
    sage: z.number().int().min(0).max(16).default(1),
  }).default({}),

  storage: z.object({
    globalWorkspaceLimitGb: z.number().int().min(1).default(80),
    reserveDiskGb: z.number().int().min(1).default(10),
    maxConcurrentDownloads: z.number().int().min(1).max(8).default(2),
    perChallengeSoftLimitGb: z.number().int().min(1).default(8),
  }).default({}),

  agent: z.object({
    progressIntervalMs: z.number().int().min(10_000).default(120_000),
    reflectionAfterStalledMs: z.number().int().min(10_000).default(300_000),
    stallDetectMs: z.number().int().min(10_000).default(180_000),
    contextCompactThreshold: z.number().min(0.5).max(0.95).default(0.8),
    compactTriggerThreshold: z.number().min(0.5).max(0.95).default(0.7),
    /** When false, missing providers block solvers instead of silently using Mock. */
    allowMockFallback: z.boolean().default(true),
  }).default({}),

  watchdog: z.object({
    checkMs: z.number().int().min(1000).default(30_000),
    heartbeatMs: z.number().int().min(1000).default(15_000),
    leaseTtlMs: z.number().int().min(1000).default(45_000),
  }).default({}),

  models: z.object({
    primary: z.string().nullable().default(null),
    fallback: z.string().nullable().default(null),
    autoFallback: z.boolean().default(false),
  }).default({}),

  visual: z.object({
    maxVisionCallsPerChallenge: z.number().int().min(0).max(200).default(40),
    maxImagesPerCall: z.number().int().min(1).max(8).default(4),
  }).default({}),

  manager: z.object({
    enabled: z.boolean().default(false),
    mode: z.enum(["OFF", "SHADOW", "ACTIVE"]).default("SHADOW"),
    replanIntervalMs: z.number().int().min(5_000).max(600_000).default(30_000),
    debounceMs: z.number().int().min(0).max(60_000).default(5_000),
    planTtlMs: z.number().int().min(10_000).max(600_000).default(90_000),
    maxCandidates: z.number().int().min(1).max(200).default(40),
    failureMode: z.enum(["DETERMINISTIC_FALLBACK"]).default("DETERMINISTIC_FALLBACK"),
    allowAutoPark: z.boolean().default(false),
    callTimeoutMs: z.number().int().min(1_000).max(180_000).default(45_000),
  }).default({}),

  reflection: z.object({
    enabledByDefault: z.boolean().default(true),
    mode: z.enum(["OFF", "HEURISTIC", "LLM", "HYBRID"]).default("HYBRID"),
    maxConcurrent: z.number().int().min(1).max(16).default(2),
    cooldownMs: z.number().int().min(0).max(3_600_000).default(300_000),
    callTimeoutMs: z.number().int().min(1_000).max(180_000).default(45_000),
    triggers: z.object({
      stalledMs: z.number().int().min(1_000).default(120_000),
      noSignalStreak: z.number().int().min(1).max(50).default(3),
      wrongFlag: z.boolean().default(true),
      repeatedExperiment: z.boolean().default(true),
    }).default({}),
  }).default({}),

  server: z.object({
    host: z.string().default(process.env.RIO_HOST ?? "127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(Number(process.env.RIO_PORT ?? 3000)),
    apiToken: z.string().nullable().default(process.env.RIO_API_TOKEN ?? null),
  }).default({}),

  paths: z.object({
    dataDir: z.string().default(resolve(process.env.RIO_DATA_DIR ?? "./data")),
    configDir: z.string().default(resolve("./config")),
  }).default({}),

  logLevel: z.string().default(process.env.RIO_LOG_LEVEL ?? "info"),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export type EffectiveManagerMode = "OFF" | "SHADOW" | "ACTIVE";

/** enabled=false (default) keeps MVP-2 scheduler behavior regardless of mode. */
export function effectiveManagerMode(cfg: Pick<RuntimeConfig, "manager">): EffectiveManagerMode {
  if (!cfg.manager.enabled || cfg.manager.mode === "OFF") return "OFF";
  return cfg.manager.mode;
}

export function defaultConfig(): RuntimeConfig {
  return runtimeConfigSchema.parse({});
}

/** Prefer RIO_CONFIG, then cwd/config, then walk up so `npm run dev -w apps/server` still finds the repo yaml. */
export function resolveConfigPath(filePath?: string): string {
  if (filePath) return filePath;
  if (process.env.RIO_CONFIG) return resolve(process.env.RIO_CONFIG);
  let dir = resolve(".");
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "config", "runtime.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(resolve("./config"), "runtime.yaml");
}

export function loadConfig(filePath?: string): RuntimeConfig {
  const path = resolveConfigPath(filePath);
  let raw: unknown = {};
  try {
    const text = readFileSync(path, "utf8");
    raw = YAML.parse(text) ?? {};
  } catch (e: unknown) {
    if (filePath) {
      throw new Error(`Failed to read config file ${filePath}: ${(e as Error).message}`);
    }
    // No default config file — use defaults (data dir still works).
  }
  const result = runtimeConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid runtime config (${path}): ${issues}`);
  }
  return result.data;
}

export type { StartPolicy };
