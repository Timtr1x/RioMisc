import { describe, it, expect } from "vitest";
import {
  adaptProviderBaseUrlForRuntime,
  baseUrlForAnthropicSdk,
  isDasctfLlmGateway,
  resolveChatEndpoint,
} from "@rio/shared";

const GW = "https://llm-gateway.dasctf.com/llm-gateway/proxy/e/ROOTaD_VNfr2UJwy";

describe("DASCTF LLM gateway endpoint resolution", () => {
  it("detects gateway URLs", () => {
    expect(isDasctfLlmGateway(GW)).toBe(true);
    expect(isDasctfLlmGateway("https://api.minimaxi.com/anthropic")).toBe(false);
  });

  it("does not append /v1/messages to gateway for direct HTTP clients", () => {
    expect(resolveChatEndpoint(GW, "ANTHROPIC_MESSAGES")).toBe(GW);
    expect(resolveChatEndpoint("https://api.minimaxi.com/anthropic", "ANTHROPIC_MESSAGES")).toBe(
      "https://api.minimaxi.com/anthropic/v1/messages",
    );
  });

  it("adds # shim so Anthropic SDK concat keeps gateway pathname", () => {
    expect(baseUrlForAnthropicSdk(GW)).toBe(`${GW}#`);
    const joined = `${baseUrlForAnthropicSdk(GW)}/v1/messages`;
    expect(new URL(joined).pathname).toBe("/llm-gateway/proxy/e/ROOTaD_VNfr2UJwy");
    expect(adaptProviderBaseUrlForRuntime(GW, "ANTHROPIC_MESSAGES")).toBe(`${GW}#`);
  });
});
