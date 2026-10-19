// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRecommendedUiPlugins } from "@/plugin-ui/adapters/useRecommendedUiPlugins.js";

const context = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  recommendations: [] as { pluginId: string; surfaceId: string }[],
  invalidate: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/hooks/useServices.js", () => ({ useServices: () => context.services }));
vi.mock("@/plugin-ui/adapters/useUiPluginRecommendations.js", () => ({
  useUiPluginRecommendations: () => ({ recommendations: context.recommendations, loading: false }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/zcodeDraftSkillInvalidation.js", () => ({
  invalidateDeferredDraftSessionForSkillChange: context.invalidate,
}));
vi.mock("@/lib/skillStoreRefresh.js", () => ({
  refreshSharedSkillStoreForWorkspace: context.refresh,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const id = "panel@zcode-plugins-official";
function setup() {
  let installed = false,
    enabled = false;
  const service = {
    listPlugins: vi.fn(async () => ({
      plugins: installed
        ? [{ id, name: "panel", marketplace: "zcode-plugins-official", enabled }]
        : [],
      diagnostics: [],
    })),
    getPluginsOverview: vi.fn(async () => ({
      marketplaces: [{ id: "zcode-plugins-official" }],
      availablePlugins: [{ id, name: "panel", marketplace: "zcode-plugins-official", installed }],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
    })),
    installPlugin: vi.fn(async () => {
      installed = true;
      return { diagnostics: [] };
    }),
    setPluginEnabled: vi.fn(async () => {
      enabled = true;
      return { diagnostics: [] };
    }),
  };
  context.services = { pluginManagementService: service, skillsService: {} };
  context.recommendations = [
    { pluginId: id, surfaceId: "main" },
    { pluginId: id, surfaceId: "main" },
    { pluginId: "missing@other", surfaceId: "main" },
  ];
  return service;
}
it("未安装和禁用仍展示，复用 user 安装与 workspace 启用，不自动打开", async () => {
  const service = setup();
  const { result } = renderHook(() =>
    useRecommendedUiPlugins({ workspacePath: "/workspace/a", sessionId: "s" }),
  );
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  expect(result.current.loading).toBe(false);
  expect(result.current.entries[0]!.item.installed).toBe(false);
  await act(async () => result.current.prepare(result.current.entries[0]!.item));
  expect(service.installPlugin).toHaveBeenCalledWith(
    expect.objectContaining({ scope: "user", pluginName: "panel" }),
  );
  expect(result.current.entries[0]!.item.installed).toBe(true);
  await act(async () => result.current.prepare(result.current.entries[0]!.item));
  expect(service.setPluginEnabled).toHaveBeenCalledWith(
    expect.objectContaining({ scope: "workspace", enabled: true }),
  );
  expect(result.current.entries[0]!.item.info?.enabled).toBe(true);
});
it("重复点击只写一次；失败保留推荐并可重试", async () => {
  const service = setup();
  const pending = Promise.withResolvers<{ diagnostics: { severity: string; message: string }[] }>();
  service.installPlugin.mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() =>
    useRecommendedUiPlugins({ workspacePath: "/workspace/a", sessionId: "s" }),
  );
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  const item = result.current.entries[0]!.item;
  let first: Promise<void>;
  act(() => {
    first = result.current.prepare(item);
    void result.current.prepare(item);
  });
  expect(service.installPlugin).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.resolve({ diagnostics: [{ severity: "error", message: "denied" }] });
    await first;
  });
  expect(result.current.error).toBe("denied");
  expect(result.current.entries[0]!.item.installed).toBe(false);
  await act(async () => result.current.prepare(item));
  expect(result.current.entries[0]!.item.installed).toBe(true);
});

it("服务切换清空目录，旧操作失败不提示到新服务", async () => {
  const old = setup();
  const pending = Promise.withResolvers<{ diagnostics: { severity: string; message: string }[] }>();
  old.installPlugin.mockReturnValueOnce(pending.promise);
  const { result, rerender } = renderHook(() =>
    useRecommendedUiPlugins({ workspacePath: "/workspace/a", sessionId: "s" }),
  );
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  let operation: Promise<void>;
  act(() => {
    operation = result.current.prepare(result.current.entries[0]!.item);
  });
  const next = setup();
  rerender();
  expect(result.current.entries).toEqual([]);
  await waitFor(() => expect(next.getPluginsOverview).toHaveBeenCalled());
  await act(async () => {
    pending.resolve({ diagnostics: [{ severity: "error", message: "old failure" }] });
    await operation;
  });
  expect(result.current.error).toBeNull();
  expect(context.invalidate).not.toHaveBeenCalled();
});

it("切换会话后迟到面板不能打开新目标", async () => {
  setup();
  const pending = Promise.withResolvers<never[]>();
  context.services.pluginUiBridgeService = {
    listSurfaces: vi.fn().mockReturnValue(pending.promise),
  };
  const { result, rerender } = renderHook(
    ({ sessionId }) => useRecommendedUiPlugins({ workspacePath: "/workspace/a", sessionId }),
    { initialProps: { sessionId: "old" } },
  );
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  const request = result.current.resolveSurface(id, "main");
  rerender({ sessionId: "new" });
  rerender({ sessionId: "old" });
  await act(async () => pending.resolve([]));
  expect(await request).toBeUndefined();
});
