const { open } = require("node:fs/promises");
const { resolve } = require("node:path");

const signScriptPath = resolve(__dirname, "../../../scripts/sign-windows.ps1");

async function isWindowsPortableExecutable(filePath) {
  // 修复原因：electron-builder 26.17 的 pnpm 收集器按 lockfile 图把 sharp 的全平台
  // optionalDependencies（darwin/linux 变体，Mach-O/ELF 格式）一并打进 app.asar.unpacked，
  // signApp 阶段遍历 unpacked 目录时会把它们送进 Windows 签名；vsigntool/DigiCert token
  // 处理非 PE 输入后会进入坏状态，同一 job 里后续所有签名连锁报 0x8010006a
  // （2026-10-26 CI 实况：第一簇纯 win32 PE 签名全绿，第二簇起全部拒绝）。
  // Windows Authenticode 只对 PE 有意义，仅在成功读取魔数且确认非 MZ 时跳过；
  // 打开/读取失败必须向上抛（评审 CR-01：读取失败被静默当作非 PE 会让
  // 真实 PE 漏签且构建不失败，签名链必须 fail-closed）。
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const magic = Buffer.alloc(2);
    const { bytesRead } = await fileHandle.read(magic, 0, 2, 0);
    if (bytesRead < 2) {
      return false;
    }
    return magic[0] === 0x4d && magic[1] === 0x5a;
  } finally {
    if (fileHandle !== undefined) {
      await fileHandle.close();
    }
  }
}

async function sign(configuration) {
  if (configuration.isNest) {
    // Bugfix: electron-builder 会按 sha1/sha256 多次调用 Windows signer，
    // 但 vsigntool 这套封装本身会完成完整签名流程，重复再签只会增加不确定性。
    // 这里跳过嵌套签名，统一以首轮调用为准，避免同一文件被重复处理。
    return;
  }

  if ((await isWindowsPortableExecutable(configuration.path)) === false) {
    console.log(`[sign-windows-hook] skip non-PE file: ${configuration.path}`);
    return;
  }

  // 在调用点 require：模块加载期解构会固化 spawnSync 原引用，测试无法替换。
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      signScriptPath,
      "-FilePath",
      configuration.path,
    ],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `[sign-windows-hook] vsigntool failed for ${configuration.path} with code ${result.status ?? "unknown"}`,
    );
  }
}

module.exports = sign;
module.exports.sign = sign;
module.exports.isWindowsPortableExecutable = isWindowsPortableExecutable;
