import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  workspace: vi.fn(async (_path: string, _timeout: number) => {}),
  defaultWorkspace: vi.fn(async () => {
    throw new Error("default workspace is not opened");
  }),
  reload: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
}));
vi.mock("./e2e/helpers/desktop-app.js", () => ({
  getE2EAppDataPaths: () => ({ configFile: "/unused/provider.json" }),
  waitForWorkspaceApp: mocks.workspace,
  waitForDefaultWorkspaceReady: mocks.defaultWorkspace,
}));
vi.mock("./e2e/helpers/e2e-electron-reload.js", () => ({
  reloadElectronSessionSafely: mocks.reload,
}));
vi.mock("./e2e/helpers/e2e-electron-storage.js", () => ({ flushElectronStorageData: mocks.flush }));
vi.mock("./e2e/helpers/occupation-onboarding.js", () => ({
  skipOccupationOnboardingIfPresent: vi.fn(async () => {}),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it.each([
  "restartIntoWorkspacePreservingProfile",
  "restartIntoWorkspaceRestoringPreferences",
] as const)("%s 只等待请求的活动目录，不要求无关默认目录被重建", async (method) => {
  vi.stubGlobal("browser", {
    electron: { execute: vi.fn(async () => "/profile") },
    execute: vi.fn(async () => ({})),
    requestedCapabilities: { "goog:chromeOptions": { args: [] } },
  });
  const helpers = await import("./e2e/helpers/model-provider-restart-runtime.js");
  const afterExit = vi.fn();
  await helpers[method]("/active-project", { afterElectronProcessExit: afterExit });
  expect(mocks.defaultWorkspace).not.toHaveBeenCalled();
  expect(mocks.workspace.mock.calls.every((call) => call[0] === "/active-project")).toBe(true);
  expect(mocks.workspace).toHaveBeenCalled();
  expect(mocks.reload).toHaveBeenCalledWith(expect.anything(), {
    afterElectronProcessExit: afterExit,
  });
  expect(mocks.reload.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.workspace.mock.invocationCallOrder[0]!,
  );
});

it("重启恢复项目 Recent 和作用域映射，不复制其他 renderer 状态", async () => {
  const preferences = {
    'zcode-composer-recent:v2:["desktop","local","project-a"]': '{"mode":"yolo"}',
    'zcode-composer-workspace-scope:v1:["desktop","/active-project"]':
      '{"clientNamespace":"desktop","hostId":"local","projectId":"project-a"}',
  };
  const values: Record<string, string> = { ...preferences, unrelated: "do-not-restore" };
  const storage = Object.defineProperty(values, "setItem", {
    value: (key: string, value: string) => {
      values[key] = value;
    },
    enumerable: false,
  });
  vi.stubGlobal("window", { localStorage: storage, location: { reload: vi.fn() } });
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      Reflect.apply(fn, undefined, args),
  });
  mocks.reload.mockImplementationOnce(async () => {
    for (const key of Object.keys(values)) delete values[key];
  });
  const { restartIntoWorkspaceRestoringPreferences } =
    await import("./e2e/helpers/model-provider-restart-runtime.js");
  await restartIntoWorkspaceRestoringPreferences("/active-project");
  expect({ ...values }).toEqual(preferences);
});
