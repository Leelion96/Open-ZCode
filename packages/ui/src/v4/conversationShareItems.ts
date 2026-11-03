import {
  buildConversationTurnNavigatorItems,
  type BuildConversationTurnNavigatorItemsOptions,
  type ConversationTurnNavigatorItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

/** 分享选择是完整 product turn；提问导航只列 realUser，不能拿它代替分享目录。 */
export function buildConversationShareItems(
  units: readonly ConversationTurnRenderUnit[],
  options: BuildConversationTurnNavigatorItemsOptions,
): ConversationTurnNavigatorItem[] {
  const queries = buildConversationTurnNavigatorItems(units, options);
  // 长会话中逐回合 filter 全部 query 会形成平方级开销；一次分组仍保留原 query 顺序。
  const queriesByUnit = new Map<number, ConversationTurnNavigatorItem[]>();
  for (const query of queries) {
    const group = queriesByUnit.get(query.unitIndex);
    if (group) group.push(query);
    else queriesByUnit.set(query.unitIndex, [query]);
  }
  return units.flatMap((unit, unitIndex) => {
    const existing = queriesByUnit.get(unitIndex);
    if (existing) return existing;
    if (
      !unit.header ||
      unit.timelineOnly ||
      (!unit.assistantTextRows.length &&
        !unit.workflowLaunch &&
        !unit.header.originMeta?.workflowNotification)
    )
      return [];
    return [
      {
        key: `${unit.key}:share`,
        turnId: unit.turnId,
        unitIndex,
        rowId: unit.header.rowId,
        userPreview:
          unit.header.originMeta?.title ?? unit.workflowLaunch?.name ?? options.userFallbackPreview,
        assistantPreview:
          unit.assistantTextRows
            .map((row) => row.text)
            .join("\n")
            .slice(0, 320) || options.assistantEmptyPreview,
        assistantPreviewKind: "text" as const,
        isRunning: unit.isRunning,
      },
    ];
  });
}
