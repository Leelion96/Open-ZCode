import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  Browser,
  canDownload,
  detectBrowserPlatform,
  install,
  resolveBuildId,
} from "@puppeteer/browsers";
import { electronToChromium } from "electron-to-chromium";

export async function resolveChromedriverBuild({
  chromiumVersion,
  platform,
  canDownload: available = canDownload,
  resolveBuildId: lookup = resolveBuildId,
}) {
  if (typeof chromiumVersion !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(chromiumVersion)) {
    throw new Error("Chromium mapping unavailable; update electron-to-chromium");
  }
  if (await available({ browser: Browser.CHROMEDRIVER, buildId: chromiumVersion, platform })) {
    return chromiumVersion;
  }
  // Electron 的 Chromium 补丁未必发布所有平台驱动；官方要求用同 MAJOR.MINOR.BUILD 查询。
  const build = chromiumVersion.split(".").slice(0, 3).join(".");
  const candidate = await lookup(Browser.CHROMEDRIVER, platform, build);
  if (
    typeof candidate !== "string" ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(candidate) ||
    !candidate.startsWith(`${build}.`) ||
    !(await available({ browser: Browser.CHROMEDRIVER, buildId: candidate, platform }))
  ) {
    throw new Error(`No compatible ChromeDriver available for ${chromiumVersion} on ${platform}`);
  }
  return candidate;
}

function cacheRecordPath({ cacheDir, electronVersion, platform }) {
  return join(cacheDir, `zcode-chromedriver-${electronVersion}-${platform}.json`);
}

export async function prepareChromedriver({
  cacheDir,
  electronVersion,
  platform,
  resolveBuild = resolveChromedriverBuild,
  install: installDriver = install,
}) {
  const chromiumVersion = electronToChromium(electronVersion);
  const driverVersion = await resolveBuild({ chromiumVersion, platform });
  const { executablePath } = await installDriver({
    browser: Browser.CHROMEDRIVER,
    buildId: driverVersion,
    platform,
    cacheDir,
  });
  await access(executablePath);
  const record = { electronVersion, chromiumVersion, driverVersion, platform, executablePath };
  await mkdir(cacheDir, { recursive: true });
  const target = cacheRecordPath({ cacheDir, electronVersion, platform });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record));
    // 安装和文件校验成功后原子发布；并行预取不会留下半写的缓存身份。
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return record;
}

export async function cachedChromedriverPath({ cacheDir, electronVersion, platform }) {
  const record = JSON.parse(
    await readFile(cacheRecordPath({ cacheDir, electronVersion, platform }), "utf8"),
  );
  if (
    record.electronVersion !== electronVersion ||
    record.chromiumVersion !== electronToChromium(electronVersion) ||
    record.platform !== platform
  ) {
    throw new Error("ChromeDriver cache identity mismatch; run prefetch again");
  }
  await access(record.executablePath);
  return record.executablePath;
}

async function main() {
  const [command, cacheDir] = process.argv.slice(2);
  if (!["prepare", "path"].includes(command) || !cacheDir) {
    throw new Error("Usage: chromedriver-preflight.mjs <prepare|path> <cache-dir>");
  }
  const { devDependencies } = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
  );
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error("ChromeDriver platform unsupported");
  const input = { cacheDir, electronVersion: devDependencies.electron, platform };
  console.log(
    command === "prepare"
      ? JSON.stringify(await prepareChromedriver(input))
      : await cachedChromedriverPath(input),
  );
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
