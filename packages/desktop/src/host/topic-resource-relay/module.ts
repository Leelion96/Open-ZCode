/** Host 负责绑定资源请求的物理连接和当前 logical session。 */
export const windowTopicResourceRelayModule = {
  id: "window-topic-resource-relay",
  requires: ["services", "shared"],
  provides: ["window-topic-resource-relay"],
  publicEntrypoints: ["contract.ts", "../windowTopicResourceRelay.ts"],
} as const;
