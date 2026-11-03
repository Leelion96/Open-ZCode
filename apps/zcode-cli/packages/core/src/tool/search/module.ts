/** 搜索控制入口、目录及请求投影共用现有工具执行身份。 */
export const toolDiscoveryModule = {
  id: "tool-discovery",
  requires: ["zcode-cli"],
  provides: ["tool-discovery"],
  publicEntrypoints: [
    "contract.ts",
    "exposure.ts",
    "history.ts",
    "search.ts",
    "description.ts",
    "local-projection.ts",
    "../handlers/tool-search.ts",
    "../handlers/deferred-tool-call.ts",
    "../../../../contracts/src/tools/tool-search.ts",
  ],
} as const;
