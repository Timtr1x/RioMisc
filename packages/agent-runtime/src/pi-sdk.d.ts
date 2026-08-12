// Stub declaration for @earendil-works/pi-coding-agent so this package
// typechecks while the SDK is not installable from the public npm registry.
// The real module is loaded lazily at runtime (see pi.ts).
declare module "@earendil-works/pi-coding-agent" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pi: any;
  export default pi;
  export const createAgentSession: any;
  export const createAgentSessionRuntime: any;
  export const SessionManager: any;
  export const SettingsManager: any;
  export const ModelRuntime: any;
  export const defineTool: any;
  export const DefaultResourceLoader: any;
  export const resolveCliModel: any;
  export const getAgentDir: any;
  export type AgentSession = any;
  export type ToolDefinition = any;
}
