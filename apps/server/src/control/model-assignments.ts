import type { Repositories } from "@rio/database";
import type { ModelAssignments, ModelCapabilities, ModelConfig } from "@rio/domain";

export const MODEL_ASSIGNMENTS_KEY = "models.assignments";

export const EMPTY_MODEL_ASSIGNMENTS: ModelAssignments = {
  primarySolverModelId: null,
  reflectionModelId: null,
  visionModelId: null,
  triageModelId: null,
  managerModelId: null,
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
    n.includes("qwen2.5-vl") ||
    n.includes("minimax-m3") ||
    n.includes("minimax_m3");
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
      managerModelId: typeof v.managerModelId === "string" ? v.managerModelId : null,
    };
  } catch {
    return { ...EMPTY_MODEL_ASSIGNMENTS };
  }
}

export function loadModelAssignments(repos: Repositories): ModelAssignments {
  return parseModelAssignments(repos.settings.get(MODEL_ASSIGNMENTS_KEY));
}

export function isModelUsable(repos: Repositories, model: ModelConfig | null | undefined): model is ModelConfig {
  if (!model?.enabled) return false;
  const provider = repos.providers.get(model.providerId);
  return Boolean(provider?.enabled);
}

export function sanitizeModelAssignments(repos: Repositories, next: ModelAssignments): ModelAssignments {
  const keep = (id: string | null): string | null => {
    if (!id) return null;
    return isModelUsable(repos, repos.models.get(id)) ? id : null;
  };
  return {
    primarySolverModelId: keep(next.primarySolverModelId),
    reflectionModelId: keep(next.reflectionModelId),
    visionModelId: keep(next.visionModelId),
    triageModelId: keep(next.triageModelId),
    managerModelId: keep(next.managerModelId),
  };
}

export function saveModelAssignments(repos: Repositories, next: ModelAssignments): ModelAssignments {
  const cleaned = sanitizeModelAssignments(repos, {
    primarySolverModelId: next.primarySolverModelId || null,
    reflectionModelId: next.reflectionModelId || null,
    visionModelId: next.visionModelId || null,
    triageModelId: next.triageModelId || null,
    managerModelId: next.managerModelId || null,
  });
  repos.settings.set(MODEL_ASSIGNMENTS_KEY, JSON.stringify(cleaned));
  return cleaned;
}

export function patchModelAssignments(repos: Repositories, patch: Partial<ModelAssignments>): ModelAssignments {
  return saveModelAssignments(repos, { ...loadModelAssignments(repos), ...patch });
}

/** Drop slots that point at a removed model or a now-unusable provider. */
export function pruneUnusableAssignments(repos: Repositories): ModelAssignments {
  return saveModelAssignments(repos, loadModelAssignments(repos));
}

export type AssignmentSlot = "primarySolver" | "reflection" | "triage" | "vision" | "manager";

export function resolveAssignedModel(repos: Repositories, slot: AssignmentSlot) {
  const a = loadModelAssignments(repos);
  const id =
    slot === "primarySolver"
      ? a.primarySolverModelId
      : slot === "reflection"
        ? a.reflectionModelId
        : slot === "triage"
          ? a.triageModelId
          : slot === "manager"
            ? a.managerModelId
            : a.visionModelId;
  if (id) {
    const m = repos.models.get(id);
    if (isModelUsable(repos, m)) return m;
  }
  const usable = repos.models.listEnabled();
  if (slot === "vision") return usable.find((m) => m.capabilities.vision) ?? null;
  const primary = repos.models.primary();
  if (isModelUsable(repos, primary)) return primary;
  return usable[0] ?? null;
}
