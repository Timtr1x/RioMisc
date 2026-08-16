import type { Repositories } from "@rio/database";
import type { ModelAssignments, ModelCapabilities } from "@rio/domain";

export const MODEL_ASSIGNMENTS_KEY = "models.assignments";

export const EMPTY_MODEL_ASSIGNMENTS: ModelAssignments = {
  primarySolverModelId: null,
  reflectionModelId: null,
  visionModelId: null,
  triageModelId: null,
};

export function defaultModelCapabilities(): ModelCapabilities {
  return { text: true, toolCalling: true, vision: false, reasoning: false, structuredOutput: false };
}

export function inferModelCapabilities(modelName: string): ModelCapabilities {
  const n = modelName.toLowerCase();
  const vision =
    n.includes("vision") ||
    n.includes("-vl") ||
    n.includes("_vl") ||
    n.includes("gpt-4o") ||
    n.includes("qwen-vl") ||
    n.includes("qwen2-vl") ||
    n.includes("qwen2.5-vl");
  const reasoning = /\b(r1|o1|o3|o4|reason|thinking)\b/.test(n);
  return {
    text: true,
    toolCalling: true,
    vision,
    reasoning,
    structuredOutput: false,
  };
}

export function mergeCapabilities(
  inferred: ModelCapabilities,
  override?: Partial<ModelCapabilities> | null,
): ModelCapabilities {
  if (!override) return inferred;
  return {
    text: override.text ?? inferred.text,
    toolCalling: override.toolCalling ?? inferred.toolCalling,
    vision: override.vision ?? inferred.vision,
    reasoning: override.reasoning ?? inferred.reasoning,
    structuredOutput: override.structuredOutput ?? inferred.structuredOutput,
  };
}

export function parseModelAssignments(raw: string | null): ModelAssignments {
  if (!raw) return { ...EMPTY_MODEL_ASSIGNMENTS };
  try {
    const v = JSON.parse(raw) as Partial<ModelAssignments>;
    return {
      primarySolverModelId: typeof v.primarySolverModelId === "string" ? v.primarySolverModelId : null,
      reflectionModelId: typeof v.reflectionModelId === "string" ? v.reflectionModelId : null,
      visionModelId: typeof v.visionModelId === "string" ? v.visionModelId : null,
      triageModelId: typeof v.triageModelId === "string" ? v.triageModelId : null,
    };
  } catch {
    return { ...EMPTY_MODEL_ASSIGNMENTS };
  }
}

export function loadModelAssignments(repos: Repositories): ModelAssignments {
  return parseModelAssignments(repos.settings.get(MODEL_ASSIGNMENTS_KEY));
}

export function saveModelAssignments(repos: Repositories, next: ModelAssignments): ModelAssignments {
  const cleaned: ModelAssignments = {
    primarySolverModelId: next.primarySolverModelId || null,
    reflectionModelId: next.reflectionModelId || null,
    visionModelId: next.visionModelId || null,
    triageModelId: next.triageModelId || null,
  };
  repos.settings.set(MODEL_ASSIGNMENTS_KEY, JSON.stringify(cleaned));
  return cleaned;
}

export function patchModelAssignments(repos: Repositories, patch: Partial<ModelAssignments>): ModelAssignments {
  return saveModelAssignments(repos, { ...loadModelAssignments(repos), ...patch });
}

export type AssignmentSlot = "primarySolver" | "reflection" | "triage" | "vision";

export function resolveAssignedModel(repos: Repositories, slot: AssignmentSlot) {
  const a = loadModelAssignments(repos);
  const id =
    slot === "primarySolver"
      ? a.primarySolverModelId
      : slot === "reflection"
        ? a.reflectionModelId
        : slot === "triage"
          ? a.triageModelId
          : a.visionModelId;
  if (id) {
    const m = repos.models.get(id);
    if (m?.enabled) return m;
  }
  if (slot === "vision") return repos.models.listEnabled().find((m) => m.capabilities.vision) ?? null;
  return repos.models.primary() ?? repos.models.listEnabled()[0] ?? null;
}
