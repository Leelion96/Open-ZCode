import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import {
  PlatformChannels,
  WEB_REMOTE_CONTROL_RENDERER_ACTION_TIMEOUT_MS,
  webRemoteControlRendererActionResultSchema,
  type WebRemoteControlRendererActionRequest,
  type WebRemoteControlRendererActionResult,
} from "@zcode/shared";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WebRemoteControlRendererActionInput = DistributiveOmit<
  WebRemoteControlRendererActionRequest,
  "requestId"
>;
export type WebRemoteControlRendererActionSuccess = Extract<
  WebRemoteControlRendererActionResult,
  { success: true }
>;

/**
 * 把手机动作转给目标窗口 Renderer 执行。
 * 置顶/归档必须与侧栏走同一 controller 路由（含归档后的会话清理），因此不在 Main 直接写库。
 */
export function runWebRemoteControlActionInRenderer(
  windowId: number,
  action: WebRemoteControlRendererActionInput,
): Promise<WebRemoteControlRendererActionSuccess> {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error("Desktop window is not available for Web remote control."));
  }
  const request = {
    ...action,
    requestId: `web-remote-action-${randomUUID()}`,
  } as WebRemoteControlRendererActionRequest;

  return new Promise((resolve, reject) => {
    const dispose = () => {
      clearTimeout(timeout);
      ipcMain.removeListener(PlatformChannels.WebRemoteControlRendererAction, handleResult);
    };
    const timeout = setTimeout(() => {
      dispose();
      reject(new Error("Web remote control action timed out."));
    }, WEB_REMOTE_CONTROL_RENDERER_ACTION_TIMEOUT_MS);

    const handleResult = (event: Electron.IpcMainEvent, payload: unknown) => {
      // 只接收目标窗口对本次 requestId 的回包，其他窗口的同名 channel 消息直接忽略。
      if (event.sender.id !== win.webContents.id) return;
      const result = webRemoteControlRendererActionResultSchema.safeParse(payload);
      if (!result.success || result.data.requestId !== request.requestId) return;
      dispose();
      if (result.data.success) resolve(result.data);
      else reject(new Error(result.data.error));
    };

    ipcMain.on(PlatformChannels.WebRemoteControlRendererAction, handleResult);
    win.webContents.send(PlatformChannels.WebRemoteControlRendererAction, request);
  });
}
