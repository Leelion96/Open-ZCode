/** 响应式断言用 renderer viewport；不受桌面最小窗口或宿主屏幕可用高度限制。 */
export async function setRendererViewport(width: number, height: number) {
  await sendViewportCommand("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.waitUntil(
    () =>
      browser.execute((w, h) => window.innerWidth === w && window.innerHeight === h, width, height),
    { timeout: 10000, timeoutMsg: `renderer viewport 没有应用 ${width}x${height}` },
  );
}

export async function clearRendererViewport() {
  await sendViewportCommand("Emulation.clearDeviceMetricsOverride", {});
}

async function sendViewportCommand(method: string, params: Record<string, unknown>) {
  const url = await browser.getUrl();
  const sent = await browser.electron.execute(
    async (electron, targetUrl, command, args) => {
      const target = electron.BrowserWindow.getAllWindows().find(
        (window) => !window.isDestroyed() && window.webContents.getURL() === targetUrl,
      );
      if (!target) return false;
      // macOS 会把 BrowserWindow 高度限制在屏幕内；CSS 覆盖不能用窗口尺寸冒充。
      const debuggerApi = target.webContents.debugger;
      if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
      await debuggerApi.sendCommand(command, args);
      return true;
    },
    url,
    method,
    params,
  );
  if (!sent) throw new Error(`没有找到 viewport 所属窗口: ${url}`);
}
