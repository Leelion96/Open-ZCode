/** 离线轨迹比较只派生视图，与运行时搜索状态分开。 */
export const toolSearchComparisonModule = {
  id: "tool-search-comparison",
  requires: ["zcode-cli"],
  provides: ["tool-search-comparison"],
  publicEntrypoints: ["contract.ts", "../tool-search-comparison.ts"],
} as const;
