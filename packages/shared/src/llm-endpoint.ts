/**
 * Resolve chat/completions or messages URLs for OpenAI/Anthropic-compatible hosts.
 *
 * DASCTF LLM gateway special case (game/gateway_doc.md):
 * If the console "原始 URL" already includes `/v1/messages` (e.g.
 * `https://api.minimaxi.com/anthropic/v1/messages`), the generated gateway URL
 * *is* the full upstream endpoint. POSTing `{gateway}/v1/messages` returns 404.
 */

export function isDasctfLlmGateway(baseUrl: string): boolean {
  return /\/llm-gateway\/proxy\//i.test(baseUrl);
}

/** Direct HTTP clients (registry test, advisory, vision) — use gateway root as-is. */
export function resolveChatEndpoint(
  baseUrl: string,
  protocol: "OPENAI_CHAT_COMPLETIONS" | "OPENAI_RESPONSES" | "ANTHROPIC_MESSAGES" | string,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (/\/messages$/i.test(base) || /\/chat\/completions$/i.test(base) || /\/responses$/i.test(base)) {
    return base;
  }
  if (isDasctfLlmGateway(base)) return base;

  const hasV1 = /\/v\d+$/i.test(base) || /\/v\d+\/[a-z]+$/i.test(base);
  switch (protocol) {
    case "ANTHROPIC_MESSAGES":
      return hasV1 ? `${base}/messages` : `${base}/v1/messages`;
    case "OPENAI_RESPONSES":
      return hasV1 ? `${base}/responses` : `${base}/v1/responses`;
    case "OPENAI_CHAT_COMPLETIONS":
    default:
      return hasV1 ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }
}

/**
 * Anthropic official SDK / Pi `anthropic-messages` always appends `/v1/messages`
 * via string concat. For a DASCTF gateway that is already the full endpoint,
 * put a `#` so `/v1/messages` becomes a URL fragment and the request path stays
 * the gateway root.
 */
export function baseUrlForAnthropicSdk(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (!isDasctfLlmGateway(base)) return base;
  if (base.includes("#")) return base;
  return `${base}#`;
}

/** Apply SDK-specific baseUrl rewrites before handing providers to Pi. */
export function adaptProviderBaseUrlForRuntime(
  baseUrl: string,
  protocol: "OPENAI_CHAT_COMPLETIONS" | "OPENAI_RESPONSES" | "ANTHROPIC_MESSAGES" | string,
): string {
  if (protocol === "ANTHROPIC_MESSAGES") return baseUrlForAnthropicSdk(baseUrl);
  // OpenAI-compatible SDKs similarly append /v1/chat/completions.
  if (
    (protocol === "OPENAI_CHAT_COMPLETIONS" || protocol === "OPENAI_RESPONSES") &&
    isDasctfLlmGateway(baseUrl)
  ) {
    const base = baseUrl.replace(/\/+$/, "");
    return base.includes("#") ? base : `${base}#`;
  }
  return baseUrl.replace(/\/+$/, "");
}
