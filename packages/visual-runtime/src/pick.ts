/** Decide whether a configured vision slot can actually run image understanding. */

export interface VisionProviderLike {
  modelId: string;
  apiKey: string;
  vision?: boolean;
}

export interface VisionPickResult<T extends VisionProviderLike = VisionProviderLike> {
  /** Provider to use for vision HTTP calls; null when vision must not run. */
  provider: T | null;
  /**
   * Human-readable reason for Solver when vision was configured incorrectly
   * (e.g. text-only model assigned to the vision slot). Null when vision is
   * simply unset / unused — AUTO local analysis may stay silent.
   */
  unavailableReason: string | null;
}

export function visionUnavailableAssigned(modelId: string): string {
  return (
    `Vision model feature unavailable: assigned model "${modelId}" does not support vision ` +
    `(capabilities.vision=false). Use mode=LOCAL_ONLY / local image tools, or assign a vision-capable model.`
  );
}

export function visionUnavailableMissing(): string {
  return "Vision model feature unavailable: no vision-capable model is configured.";
}

/**
 * Resolve which provider should back vision calls.
 *
 * - Assigned model without vision → no provider, explicit unavailable reason (no silent fallback).
 * - Assigned vision-capable model → that provider.
 * - No assignment → first vision-capable provider, else null with no reason (optional feature).
 */
export function resolveVisionProvider<T extends VisionProviderLike>(
  providers: T[],
  visionModelId?: string | null,
): VisionPickResult<T> {
  const named = visionModelId?.trim() || null;
  if (named) {
    const assigned = providers.find((p) => p.modelId === named && p.apiKey);
    if (assigned) {
      if (!assigned.vision) {
        return { provider: null, unavailableReason: visionUnavailableAssigned(assigned.modelId) };
      }
      return { provider: assigned, unavailableReason: null };
    }
    // Assigned id not present among decrypted providers — fall back if possible.
  }
  const capable = providers.find((p) => p.vision && p.apiKey) ?? null;
  return { provider: capable, unavailableReason: null };
}
