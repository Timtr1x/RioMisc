import { describe, it, expect } from "vitest";
import { compatFlagsFor, inferCompatProfile, resolveCompatProfile, selectPiProvider } from "@rio/agent-runtime";

describe("compat profile", () => {
  it("AUTO infers DeepSeek / OpenAI / Anthropic / ZAI", () => {
    expect(inferCompatProfile({ protocol: "OPENAI_CHAT_COMPLETIONS", baseUrl: "https://opencode.ai/zen/go/v1", modelId: "deepseek-v4-flash" })).toBe("DEEPSEEK");
    expect(inferCompatProfile({ protocol: "OPENAI_CHAT_COMPLETIONS", baseUrl: "https://api.openai.com/v1", modelId: "gpt-4.1" })).toBe("OPENAI");
    expect(inferCompatProfile({ protocol: "ANTHROPIC_MESSAGES", baseUrl: "https://api.anthropic.com", modelId: "claude" })).toBe("ANTHROPIC");
    expect(inferCompatProfile({ protocol: "OPENAI_CHAT_COMPLETIONS", baseUrl: "https://api.z.ai/api/paas/v4", modelId: "glm-4" })).toBe("ZAI");
  });

  it("explicit profile wins over AUTO inference", () => {
    expect(
      resolveCompatProfile("OPENAI", {
        protocol: "OPENAI_CHAT_COMPLETIONS",
        baseUrl: "https://opencode.ai/zen/go/v1",
        modelId: "deepseek-v4-flash",
      }),
    ).toBe("OPENAI");
  });

  it("only DeepSeek gets thinkingFormat=deepseek", () => {
    expect(compatFlagsFor("DEEPSEEK").thinkingFormat).toBe("deepseek");
    expect(compatFlagsFor("OPENAI").thinkingFormat).toBeUndefined();
    expect(compatFlagsFor("OPENAI").supportsReasoningEffort).toBe(false);
    expect(compatFlagsFor("ANTHROPIC").supportsDeveloperRole).toBe(true);
  });

  it("switchModel refuses a model that is not in the current provider list", () => {
    expect(() => selectPiProvider([{ modelId: "deepseek-v4-flash" }], "gpt-4.1")).toThrow(/not in the current provider list/);
    expect(selectPiProvider([{ modelId: "a" }, { modelId: "b" }], "b").modelId).toBe("b");
  });
});
