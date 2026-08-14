import { describe, it, expect } from "vitest";
import {
  PiAgentRuntimeAdapter,
  buildPiModelsDocument,
  resolveModelOnRuntime,
  type PiProviderSpec,
} from "@rio/agent-runtime";

function spec(modelId: string, id = "prov_a"): PiProviderSpec {
  return {
    id,
    displayName: "Provider A",
    protocol: "OPENAI_CHAT_COMPLETIONS",
    baseUrl: "https://api.example.com/v1",
    apiKeyRef: "k",
    apiKey: "secret",
    modelId,
    contextWindow: 32_000,
    maxOutputTokens: 4096,
    compatProfile: "OPENAI",
  };
}

describe("switchModel reuses the session ModelRuntime", () => {
  it("writes A1 and A2 into the same provider document", () => {
    const doc = buildPiModelsDocument([spec("A1"), spec("A2")]);
    expect(Object.keys(doc.providers)).toEqual(["prov_a"]);
    expect(doc.providers.prov_a!.models.map((m) => m.id)).toEqual(["A1", "A2"]);
  });

  it("resolveModelOnRuntime throws when the current runtime has no such model", () => {
    const runtime = { getModel: () => null };
    expect(() => resolveModelOnRuntime(runtime, { id: "prov_a", modelId: "A2" })).toThrow(
      /not found in current session runtime/,
    );
  });

  it("A1 → A2 calls setModel on the existing runtime and never creates another", async () => {
    const adapter = new PiAgentRuntimeAdapter("unused");
    adapter.withProviders([spec("A1"), spec("A2")]);
    const seen: string[] = [];
    const set: unknown[] = [];
    const runtime = {
      getModel: (providerId: string, modelId: string) => {
        seen.push(`${providerId}:${modelId}`);
        return modelId === "A2" ? { id: modelId, providerId } : null;
      },
    };
    const handle = {
      sessionId: "s1",
      modelRuntime: runtime,
      providers: [spec("A1"), spec("A2")],
      piSession: {
        setModel: async (model: unknown) => {
          set.push(model);
        },
      },
    };
    await adapter.switchModel(handle as never, { providerId: "prov_a", modelId: "A2" });
    expect(seen).toEqual(["prov_a:A2"]);
    expect(set).toEqual([{ id: "A2", providerId: "prov_a" }]);
  });

  it("refuses a model the current provider list does not have", async () => {
    const adapter = new PiAgentRuntimeAdapter("unused");
    adapter.withProviders([spec("A1"), spec("A2")]);
    await expect(
      adapter.switchModel(
        {
          sessionId: "s1",
          modelRuntime: { getModel: () => ({ id: "ghost" }) },
          providers: [spec("A1"), spec("A2")],
          piSession: { setModel: async () => {} },
        } as never,
        { providerId: "prov_a", modelId: "B1" },
      ),
    ).rejects.toThrow(/not in the current provider list/);
  });
});
