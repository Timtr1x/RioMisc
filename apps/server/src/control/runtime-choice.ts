// Choose mock vs Pi at the moment a worker starts — not once at process boot.
// Adding a provider/key in the Dashboard must take effect on the next solver.
import type { Repositories } from "@rio/database";

export function resolveAgentRuntime(repos: Repositories): "mock" | "pi" {
  const env = process.env.RIO_AGENT_RUNTIME;
  if (env === "mock" || env === "pi") return env;
  const hasProvider = repos.providers.list().some((p) => p.enabled);
  const hasModel = repos.models.listEnabled().length > 0;
  return hasProvider && hasModel ? "pi" : "mock";
}
