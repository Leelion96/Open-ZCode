import { useEffect, useMemo } from "react";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import {
  DEFAULT_PLAN_NODE_KEY,
  type ModelProviderNavGroup,
} from "./constants.js";
import { createCustomProviderNodeKey } from "./utils.js";
import type { useModelProviderNavigation } from "./useModelProviderNavigation.js";

// 沿用上游调用契约，导航规则独立实现；type-only 引用不会运行上游 hook。
export function useOpenZCodeModelProviderNavigation({
  modelProviders,
  displayOrder,
  selectedNodeKey,
  setSelectedNodeKey,
  intl,
}: Parameters<typeof useModelProviderNavigation>[0]): ReturnType<typeof useModelProviderNavigation> {
  const customProviders = useMemo(
    () => sortModelProvidersForDisplay(
      modelProviders.filter((provider) => provider.config.group === "standard-personal"),
      displayOrder,
    ),
    [displayOrder, modelProviders],
  );

  const navigationGroups = useMemo<ModelProviderNavGroup[]>(() => [
    {
      id: "preset",
      title: intl.formatMessage({ id: "settings.modelProvider.presetTitle" }),
      items: [
        {
          key: DEFAULT_PLAN_NODE_KEY,
          type: "planPlaceholder",
          label: "Default Plan",
        },
      ],
    },
    {
      id: "custom",
      title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
      items: customProviders.map((provider) => ({
        key: createCustomProviderNodeKey(provider.providerId),
        type: "custom" as const,
        label: getProviderFormLabel(provider),
        provider,
        statusActive: provider.executable === true,
      })),
    },
  ], [customProviders, intl]);

  const navigationItems = useMemo(
    () => navigationGroups.flatMap((group) => group.items),
    [navigationGroups],
  );
  const requestedNavItem = navigationItems.find((item) => item.key === selectedNodeKey);
  const selectedNavItem = requestedNavItem && requestedNavItem.type !== "codingPlanLoading"
    ? requestedNavItem
    : navigationItems.find((item) => item.type === "planPlaceholder") ?? null;
  const resolvedNodeKey = selectedNavItem?.key ?? DEFAULT_PLAN_NODE_KEY;

  useEffect(() => {
    // 只校正页面局部选中项，不写账号域、连接偏好或会话模型选择。
    if (selectedNodeKey !== resolvedNodeKey) {
      setSelectedNodeKey(resolvedNodeKey);
    }
  }, [resolvedNodeKey, selectedNodeKey, setSelectedNodeKey]);

  return {
    navigationGroups,
    navigationItems,
    selectedNavItem,
    navigationUnavailable: false,
  };
}
