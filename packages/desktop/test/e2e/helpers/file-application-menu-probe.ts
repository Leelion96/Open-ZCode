import {
  PlatformChannels,
  type FileApplicationInfo,
  type FileApplicationTarget,
} from "@zcode/shared";

type Handler = (...args: unknown[]) => unknown;
declare global {
  var __apcFileApplications:
    | {
        calls: Array<{ applicationId: string; target: FileApplicationTarget }>;
        restore(): void;
      }
    | undefined;
}

/** 只在隔离 E2E 主进程替换目标文件的 IPC；不启动或安装任何真实外部应用。 */
export async function installFileApplicationMenuProbe(
  targetPath: string,
  applications: FileApplicationInfo[],
) {
  await browser.electron.execute(
    (electron, channels, targetPath, applications) => {
      if (globalThis.__apcFileApplications)
        throw new Error("File application probe already installed");
      const handlers = (electron.ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers;
      const query = handlers.get(channels.GetFileApplications);
      const open = handlers.get(channels.OpenFileWithApplication);
      if (!query || !open) throw new Error("File application IPC handlers unavailable");
      const probe = {
        calls: [] as Array<{ applicationId: string; target: FileApplicationTarget }>,
        restore() {
          handlers.set(channels.GetFileApplications, query);
          handlers.set(channels.OpenFileWithApplication, open);
          delete globalThis.__apcFileApplications;
        },
      };
      handlers.set(channels.GetFileApplications, (event, target) =>
        (target as FileApplicationTarget)?.path === targetPath
          ? applications
          : query(event, target),
      );
      handlers.set(channels.OpenFileWithApplication, (event, payload) => {
        const request = payload as { applicationId: string; target: FileApplicationTarget };
        if (request?.target?.path !== targetPath) return open(event, payload);
        probe.calls.push(request);
        return { success: true };
      });
      globalThis.__apcFileApplications = probe;
    },
    PlatformChannels,
    targetPath,
    applications,
  );
}

export async function readFileApplicationMenuProbe() {
  return browser.electron.execute(() => globalThis.__apcFileApplications?.calls ?? []);
}

export async function restoreFileApplicationMenuProbe() {
  await browser.electron.execute(() => globalThis.__apcFileApplications?.restore());
}
