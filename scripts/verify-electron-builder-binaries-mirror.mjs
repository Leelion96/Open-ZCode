#!/usr/bin/env node
// electron-builder 26.17 起，macOS 打包在签名后并发下载 7zip@1.0.0 与 dmg-builder@1.2.5。
// 内网镜像若未同步这些新目录，失败要到 ZIP/DMG 阶段才以通用 404 暴露（2026-10-20 CI 实况）。
// 本脚本在 Builder 启动前按构建宿主架构对镜像做只读 GET + 字节级 size/SHA-256 校验：
// 不接受暖缓存或 HEAD 代替；缺失即带着 release/file/url 明确失败。它只读镜像，
// 不发布、不猜测镜像服务的物理目录，同步与原子发布由运维维护。

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { resolveIntranetDepsBaseUrl } from "./intranetDefaults.mjs";

const require = createRequire(import.meta.url);
const workspaceRoot = new URL("../package.json", import.meta.url);

function resolveArgs(argv) {
  const options = {
    hostArch: process.arch,
    mirror: null,
    json: "scripts/electron-builder-binaries-macos.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host-arch") {
      options.hostArch = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--host-arch=")) {
      options.hostArch = arg.slice("--host-arch=".length);
      continue;
    }
    if (arg === "--mirror") {
      options.mirror = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--mirror=")) {
      options.mirror = arg.slice("--mirror=".length);
      continue;
    }
    throw new Error(`不支持参数: ${arg}`);
  }
  return options;
}

function assertToolchain(manifest, rootUrl) {
  const rootRequire = createRequire(rootUrl);
  const electronBuilderEntry = rootRequire.resolve("electron-builder/package.json");
  const expected = {
    electronBuilder: require(electronBuilderEntry).version,
    appBuilderLib: require(
      require.resolve("app-builder-lib/package.json", { paths: [electronBuilderEntry] }),
    ).version,
    // dmg-builder 的 npm 版本（26.x）与其工具 release tag（dmg-builder@1.2.5）是两个概念；
    // 这里绑定 npm 版本，清单资产仍按 release tag 命名目录。
    dmgBuilder: require(
      require.resolve("dmg-builder/package.json", { paths: [electronBuilderEntry] }),
    ).version,
  };
  const mismatched = Object.entries(expected).filter(
    ([key, version]) => manifest.toolchain[key] !== version,
  );
  if (mismatched.length > 0) {
    throw new Error(
      `镜像清单与已安装工具链不一致，先审查并更新清单: ${mismatched
        .map(([key, version]) => `${key} 清单=${manifest.toolchain[key]} 实际=${version}`)
        .join("; ")}`,
    );
  }
  return expected;
}

export function selectHostAssets(manifest, hostArch) {
  // Node 的 process.arch 在 darwin x64 主机上是 "x64"，而 electron-builder-binaries
  // 的 macOS 工具目录命名是 x86_64；这里统一归一，CI 不再需要在 YAML 里内联
  // node -p 做架构换算（"? : " 中的冒号加空格会破坏未加引号的 YAML 标量）。
  const normalizedArch = hostArch === "x64" ? "x86_64" : hostArch;
  const assets = manifest.hostAssets[`darwin-${normalizedArch}`];
  if (!assets || assets.length === 0) {
    throw new Error(`清单缺少 darwin-${normalizedArch} 的工具资产`);
  }
  return assets;
}

// 评审 CR-01：预检请求必须有总时限。镜像建立 TCP 后不返回响应头、或返回 200 后
// 停止发送响应体时，无 signal 的 fetch 会无界等待；该步骤位于 bundle.mjs 的有限
// 重试之外，macOS job 只能等 runner 超时。AbortSignal.timeout 覆盖连接、响应头
// 与响应体读取全程；默认 60s，测试可通过参数注入更短时限。
const ASSET_REQUEST_TIMEOUT_MS = 60_000;

async function downloadAsset(url, timeoutMs = ASSET_REQUEST_TIMEOUT_MS) {
  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`镜像资产请求失败（含超时）: ${url} ${error.message}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  const hash = createHash("sha256");
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      size += chunk.length;
      hash.update(chunk);
      chunks.push(chunk);
    }
  } catch (error) {
    throw new Error(`镜像资产响应体读取失败（含停滞超时）: ${url} ${error.message}`, {
      cause: error,
    });
  }
  return { size, sha256: hash.digest("hex"), bytes: Buffer.concat(chunks) };
}

export function buildAssetUrl(mirror, asset) {
  return `${mirror.replace(/\/+$/, "")}/${encodeURIComponent(asset.release)}/${asset.file}`;
}

async function verifyAsset(mirror, asset, timeoutMs) {
  const url = buildAssetUrl(mirror, asset);
  const downloaded = await downloadAsset(url, timeoutMs);
  if (downloaded.size !== asset.size) {
    throw new Error(`size mismatch: ${url} 期望=${asset.size} 实际=${downloaded.size}`);
  }
  if (downloaded.sha256 !== asset.sha256) {
    throw new Error(`sha256 mismatch: ${url} 期望=${asset.sha256} 实际=${downloaded.sha256}`);
  }
  return { url, size: downloaded.size, sha256: downloaded.sha256 };
}

export function resolveVerifyMirror(env = process.env) {
  // 与 packages/desktop/scripts/bundle.mjs 的默认镜像同源：优先显式 mirror 变量，
  // 否则按内网 deps base URL 推导；未配置内网源时（开源构建）明确失败，
  // 因为官方 GitHub 源在此网络环境下不可达，预检没有意义。
  const explicit =
    env.NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR ||
    env.npm_config_electron_builder_binaries_mirror ||
    env.npm_package_config_electron_builder_binaries_mirror ||
    env.ELECTRON_BUILDER_BINARIES_MIRROR;
  if (explicit?.trim()) {
    return explicit.trim();
  }
  return `${resolveIntranetDepsBaseUrl(env)}/electron-builder-binaries/`;
}

export async function verifyElectronBuilderBinariesMirror({
  manifest,
  mirror,
  hostArch,
  toolchain,
  timeoutMs,
} = {}) {
  const resolvedManifest =
    manifest ?? require(require.resolve("./electron-builder-binaries-macos.json", import.meta.url));
  const resolvedMirror = (mirror ?? resolveVerifyMirror()).trim();
  if (!resolvedMirror) {
    throw new Error("缺少 Builder 工具镜像地址（--mirror 或 ELECTRON_BUILDER_BINARIES_MIRROR）");
  }
  const resolvedToolchain = toolchain ?? assertToolchain(resolvedManifest, workspaceRoot);
  const assets = selectHostAssets(resolvedManifest, hostArch);
  const verified = [];
  for (const asset of assets) {
    verified.push(await verifyAsset(resolvedMirror, asset, timeoutMs));
  }
  return { toolchain: resolvedToolchain, hostArch, mirror: resolvedMirror, verified };
}

async function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(`electron-builder 工具镜像只读预检

用法:
  node scripts/verify-electron-builder-binaries-mirror.mjs [--host-arch <arm64|x86_64>] [--mirror <url>]

默认读取 ELECTRON_BUILDER_BINARIES_MIRROR 与当前构建宿主架构。`);
    process.exit(0);
  }

  const options = resolveArgs(process.argv.slice(2));
  const result = await verifyElectronBuilderBinariesMirror(options);
  for (const asset of result.verified) {
    console.log(`[mirror-check] ok ${asset.url} size=${asset.size} sha256=${asset.sha256}`);
  }
}

// 修复原因（评审 CR-02）：手工拼接 file:/// URL 在 POSIX 上会把绝对路径拼成
// file:////…（四个斜杠），与 import.meta.url 恒不相等，main() 永不执行、
// CI 预检以退出码 0 假成功。文件路径必须经 pathToFileURL() 转换（与 bundle.mjs 一致）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
