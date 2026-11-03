import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  buildAssetUrl,
  selectHostAssets,
  resolveVerifyMirror,
  verifyElectronBuilderBinariesMirror,
} = await import("../verify-electron-builder-binaries-mirror.mjs");

const MANIFEST = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../electron-builder-binaries-macos.json"), "utf8"),
);

const TOOLCHAIN_FIXTURE = {
  electronBuilder: "26.17.0",
  appBuilderLib: "26.17.0",
  dmgBuilder: "26.17.0",
};

function startServer(handler) {
  return new Promise((resolveServer) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function serverBaseUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function withServer(handler, run) {
  const server = await startServer(handler);
  try {
    return await run(`${serverBaseUrl(server)}/electron-builder-binaries/`);
  } finally {
    // 停滞注入用例会留下未完成连接；close 前强制断开，避免等待残留套接字。
    server.closeAllConnections?.();
    await new Promise((done) => server.close(done));
  }
}

test("镜像清单绑定当前安装的 Builder 工具链版本", () => {
  const electronBuilderEntry = require.resolve(
    "electron-builder/package.json",
    resolve(import.meta.dirname, "../../package.json"),
  );
  const expected = {
    electronBuilder: require(electronBuilderEntry).version,
    appBuilderLib: require(
      require.resolve("app-builder-lib/package.json", { paths: [electronBuilderEntry] }),
    ).version,
    // dmg-builder 的 npm 版本（26.x）与其工具 release tag（dmg-builder@1.2.5）是两个概念。
    dmgBuilder: require(
      require.resolve("dmg-builder/package.json", { paths: [electronBuilderEntry] }),
    ).version,
  };
  assert.deepEqual(MANIFEST.toolchain, expected);
});

test("macOS 两个宿主架构各有一组完整资产且 URL 结构正确", () => {
  assert.deepEqual(Object.keys(MANIFEST.hostAssets).sort(), ["darwin-arm64", "darwin-x86_64"]);
  for (const assets of Object.values(MANIFEST.hostAssets)) {
    assert.equal(assets.length, 2);
    assert.deepEqual([...new Set(assets.map((asset) => asset.release))].sort(), [
      "7zip@1.0.0",
      "dmg-builder@1.2.5",
    ]);
    for (const asset of assets) {
      assert.match(asset.file, /^[\w.-]+\.tar\.gz$/);
      assert.ok(asset.size > 0);
      assert.match(asset.sha256, /^[0-9a-f]{64}$/);
      assert.equal(
        buildAssetUrl("http://mirror.test/electron-builder-binaries/", asset),
        `http://mirror.test/electron-builder-binaries/${encodeURIComponent(asset.release)}/${asset.file}`,
      );
    }
  }
});

test("未知宿主架构必须明确失败", () => {
  assert.throws(() => selectHostAssets(MANIFEST, "ia32"), /darwin-ia32/);
});

test("process.arch 的 x64 归一为清单的 darwin-x86_64 资产", () => {
  // CI 直接调用脚本、不传 --host-arch 时走 process.arch 默认值；
  // x64 主机必须命中 x86_64 工具目录，而不是报清单缺失。
  assert.deepEqual(selectHostAssets(MANIFEST, "x64"), MANIFEST.hostAssets["darwin-x86_64"]);
  assert.deepEqual(selectHostAssets(MANIFEST, "x86_64"), MANIFEST.hostAssets["darwin-x86_64"]);
});

test("镜像资产完整时逐字节校验通过", async () => {
  const payload = Buffer.from("electron-builder-mirror-fixture");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const manifest = {
    ...MANIFEST,
    hostAssets: {
      "darwin-arm64": MANIFEST.hostAssets["darwin-arm64"].map((asset) => ({
        ...asset,
        size: payload.length,
        sha256,
      })),
    },
  };

  await withServer(
    (request, response) => {
      const segments = request.url.split("/");
      const release = decodeURIComponent(segments.at(-2) ?? "");
      const file = segments.at(-1) ?? "";
      const known = MANIFEST.hostAssets["darwin-arm64"].some(
        (asset) => asset.release === release && asset.file === file,
      );
      if (!known) {
        response.statusCode = 404;
        response.end("missing");
        return;
      }
      response.statusCode = 200;
      response.end(payload);
    },
    async (mirror) => {
      const result = await verifyElectronBuilderBinariesMirror({
        manifest,
        mirror,
        hostArch: "arm64",
        toolchain: TOOLCHAIN_FIXTURE,
      });
      assert.equal(result.verified.length, 2);
      assert.ok(result.verified.every((asset) => asset.size === payload.length));
      assert.ok(result.verified.every((asset) => asset.sha256 === sha256));
    },
  );
});

test("镜像缺失资产时在打包前报出 release/file/url", async () => {
  await withServer(
    (request, response) => {
      response.statusCode = 404;
      response.end("missing");
    },
    async (mirror) => {
      await assert.rejects(
        verifyElectronBuilderBinariesMirror({
          manifest: MANIFEST,
          mirror,
          hostArch: "arm64",
          toolchain: TOOLCHAIN_FIXTURE,
        }),
        /7zip%401\.0\.0\/7zip-darwin-arm64\.tar\.gz/,
      );
    },
  );
});

test("镜像资产字节与清单不符时按 size 或 sha256 明确失败", async () => {
  const payload = Buffer.from("tampered-payload");
  const sha256 = createHash("sha256").update(payload).digest("hex");

  await withServer(
    (request, response) => {
      response.statusCode = 200;
      response.end(payload);
    },
    async (mirror) => {
      const sizeMismatch = {
        ...MANIFEST,
        hostAssets: {
          "darwin-arm64": MANIFEST.hostAssets["darwin-arm64"].map((asset, index) => ({
            ...asset,
            size: index === 0 ? payload.length + 1 : payload.length,
            sha256,
          })),
        },
      };
      await assert.rejects(
        verifyElectronBuilderBinariesMirror({
          manifest: sizeMismatch,
          mirror,
          hostArch: "arm64",
          toolchain: TOOLCHAIN_FIXTURE,
        }),
        /size mismatch/,
      );

      const shaMismatch = {
        ...MANIFEST,
        hostAssets: {
          "darwin-arm64": MANIFEST.hostAssets["darwin-arm64"].map((asset) => ({
            ...asset,
            size: payload.length,
            sha256: "0".repeat(64),
          })),
        },
      };
      await assert.rejects(
        verifyElectronBuilderBinariesMirror({
          manifest: shaMismatch,
          mirror,
          hostArch: "arm64",
          toolchain: TOOLCHAIN_FIXTURE,
        }),
        /sha256 mismatch/,
      );
    },
  );
});

test("清单版本与安装工具链不一致时 fail-fast", async () => {
  await withServer(
    (request, response) => {
      response.statusCode = 200;
      response.end("unused");
    },
    async (mirror) => {
      await assert.rejects(
        verifyElectronBuilderBinariesMirror({
          manifest: {
            ...MANIFEST,
            toolchain: { ...TOOLCHAIN_FIXTURE, electronBuilder: "26.8.1" },
          },
          mirror,
          hostArch: "arm64",
        }),
        /清单与已安装工具链不一致/,
      );
    },
  );
});

test("缺少镜像地址时明确失败", async () => {
  await assert.rejects(
    verifyElectronBuilderBinariesMirror({
      manifest: MANIFEST,
      mirror: "  ",
      hostArch: "arm64",
      toolchain: TOOLCHAIN_FIXTURE,
    }),
    /缺少 Builder 工具镜像地址/,
  );
});

test("未显式配置 mirror 时按内网 deps 推导默认地址", () => {
  assert.equal(
    resolveVerifyMirror({ INTRANET_MACHINE_HOST: "192.0.2.10" }),
    "http://192.0.2.10:12345/zcode/deps/electron-builder-binaries/",
  );
  assert.equal(
    resolveVerifyMirror({
      INTRANET_MACHINE_HOST: "192.0.2.10",
      ELECTRON_BUILDER_BINARIES_MIRROR: "https://mirror.example.test/builder/",
    }),
    "https://mirror.example.test/builder/",
  );
  assert.equal(
    resolveVerifyMirror({
      ZCODE_DEPS_BASE_URL: "https://deps.example.test/zcode/deps",
    }),
    "https://deps.example.test/zcode/deps/electron-builder-binaries/",
  );
  // 闭源树的内网默认机器是 intranet.example.invalid；与 bundle.mjs 的默认镜像同源。
  assert.equal(
    resolveVerifyMirror({}),
    "http://intranet.example.invalid:12345/zcode/deps/electron-builder-binaries/",
  );
});

// 评审 CR-02 回归：入口判断曾在 POSIX 上恒不匹配，CLI 以退出码 0 假成功。
// 这里用真实子进程验证 CLI 行为，而不是只导入函数。
// 必须用异步 spawn：本文件的 HTTP fixture 与测试同进程，spawnSync 会阻塞父进程
// 事件循环，服务器无法响应子进程请求，形成父子互等（评审实测确定死锁）。
import { spawn } from "node:child_process";

const CLI_TIMEOUT_MS = 30_000;

function runCli(args, extraEnv = {}) {
  const scriptPath = resolve(import.meta.dirname, "../verify-electron-builder-binaries-mirror.mjs");
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // 子进程必须有硬超时：CLI 卡死时终止进程并让测试失败，而不是占住执行器。
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`CLI 超时（${CLI_TIMEOUT_MS}ms）: ${args.join(" ")}`));
    }, CLI_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}

test("CLI --help 输出用法并以 0 退出", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /verify-electron-builder-binaries-mirror|--mirror/);
});

test("CLI 非法宿主架构以非零退出", async () => {
  const result = await runCli(["--host-arch", "bogus"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /bogus|架构|asset|darwin/);
});

test("CLI 镜像 404 以非零退出并输出缺失 URL", async () => {
  // 断言服务器确实收到请求：此前 spawnSync 死锁下该测试曾靠无关报错的
  // 脚本路径命中正则假通过，请求数与 HTTP 404 状态行缺一不可。
  let requestCount = 0;
  await withServer(
    (_req, res) => {
      requestCount += 1;
      res.statusCode = 404;
      res.end("not found");
    },
    async (mirror) => {
      const result = await runCli(["--mirror", mirror]);
      assert.notEqual(result.status, 0);
      assert.ok(requestCount > 0, "fixture 服务器未收到任何请求，CLI 未真实执行校验");
      assert.match(result.stderr + result.stdout, /HTTP 404/);
    },
  );
});

test("镜像接受请求但不响应时，预检在时限内失败并带出资产 URL（评审 CR-01）", async () => {
  await withServer(
    (_req, _res) => {
      // 接受请求但永不回写响应头/响应体，模拟内网镜像停滞。
    },
    async (mirror) => {
      await assert.rejects(
        verifyElectronBuilderBinariesMirror({
          manifest: MANIFEST,
          mirror,
          hostArch: "arm64",
          toolchain: TOOLCHAIN_FIXTURE,
          timeoutMs: 500,
        }),
        (error) =>
          error.message.includes("7zip%401.0.0") && /超时|timeout|aborted/i.test(error.message),
      );
    },
  );
});
