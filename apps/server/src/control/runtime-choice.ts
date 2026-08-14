// Choose mock vs Pi at the moment a worker starts — not once at process boot.
// Adding a provider/key in the Dashboard must take effect on the next solver.
import type { Repositories } from "@rio/database";

export function resolveAgentRuntime(
  repos: Repositories,
  opts?: { allowMockFallback?: boolean },
): "mock" | "pi" | "unavailable" {
  const env = process.env.RIO_AGENT_RUNTIME;
  if (env === "pi") return "pi";
  if (env === "mock") {
    if (opts?.allowMockFallback === false) return "unavailable";
    return "mock";
  }
  const hasProvider = repos.providers.list().some((p) => p.enabled);
  const hasModel = repos.models.listEnabled().length > 0;
  if (hasProvider && hasModel) return "pi";
  if (opts?.allowMockFallback === false) return "unavailable";
  return "mock";
}
