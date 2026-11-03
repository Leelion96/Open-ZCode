export const moduleDefinition = {
  id: "conversation-telemetry-service",
  requires: ["shared", "services", "rpc", "conversation-telemetry-engine"],
  provides: ["conversation-telemetry-service"],
} as const;
