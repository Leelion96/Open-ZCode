import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Browser, computeExecutablePath, detectBrowserPlatform } from "@puppeteer/browsers";
import { electronToChromium } from "electron-to-chromium";

export function resolveE2EChromedriverExecutable({ electronVersion, cacheDir, explicitPath }) {
  if (explicitPath) return explicitPath;
  const buildId = electronToChromium(electronVersion);
  if (!buildId) throw new Error(`Chromium mapping missing for Electron ${electronVersion}`);
  // WDIO launcher 已按该版本准备驱动；容器的兼容补丁由预取入口通过 explicitPath 提供。
  return computeExecutablePath({
    browser: Browser.CHROMEDRIVER,
    buildId,
    platform: detectBrowserPlatform(),
    cacheDir,
  });
}

/** 驱动自己持有系统分配的端口，避免探测后释放、实际绑定前被其它连接占用。 */
export async function startE2EChromedriverServer({
  executablePath,
  prefixArgs = [],
  logPath,
  timeoutMs = 30_000,
}) {
  await mkdir(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath);
  const child = spawn(
    executablePath,
    [...prefixArgs, "--port=0", "--allowed-ips=127.0.0.1", "--allowed-origins=*"],
    { env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let exited = false;
  let output = "";
  let stopping;
  const killOnWorkerExit = () => child.kill();
  process.once("exit", killOnWorkerExit);
  const closed = new Promise((resolve) => {
    child.once("close", () => {
      exited = true;
      process.removeListener("exit", killOnWorkerExit);
      log.end(resolve);
    });
  });
  const stop = () => {
    stopping ??= (async () => {
      if (!exited) child.kill();
      const deadline = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 5_000);
      try {
        await closed;
      } finally {
        clearTimeout(deadline);
      }
    })();
    return stopping;
  };
  try {
    const port = await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => finish(new Error(`ChromeDriver startup timed out; ${output.slice(-2000)}`)),
        timeoutMs,
      );
      let settled = false;
      function finish(error, actualPort) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve(actualPort);
      }
      const capture = (chunk) => {
        log.write(chunk);
        output = (output + chunk.toString()).slice(-16_384);
        const ready = output.match(/ChromeDriver was started successfully on port (\d+)\./u);
        if (ready) {
          const actualPort = Number(ready[1]);
          if (actualPort > 0 && actualPort <= 65_535) finish(null, actualPort);
          else finish(new Error(`ChromeDriver reported invalid port ${ready[1]}`));
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) =>
        finish(new Error(`ChromeDriver exited before ready (${code}/${signal}); ${output}`)),
      );
    });
    return { hostname: "127.0.0.1", port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
