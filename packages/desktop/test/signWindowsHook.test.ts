import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nodeRequire = createRequire(import.meta.url);
// 内置模块的 CJS 导出对象是全局单例，钩子在调用点 require，
// 测试通过替换该对象上的 spawnSync 拦截真实进程。
const childProcess = nodeRequire("node:child_process") as {
  spawnSync: ReturnType<typeof vi.fn>;
};

import signWindowsHook from "../scripts/sign-windows-hook.cjs";

const { isWindowsPortableExecutable } = signWindowsHook as unknown as {
  isWindowsPortableExecutable: (filePath: string) => Promise<boolean>;
};

const spawnSyncMock = vi.fn();

beforeEach(() => {
  spawnSyncMock.mockReset();
  vi.spyOn(childProcess, "spawnSync").mockImplementation((...args) =>
    spawnSyncMock(...(args as Parameters<typeof spawnSyncMock>)),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function createTempFile(name: string, magic: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-sign-hook-"));
  const filePath = join(dir, name);
  await writeFile(filePath, magic);
  return filePath;
}

async function cleanupTempFile(filePath: string): Promise<void> {
  await rm(join(filePath, ".."), { recursive: true, force: true });
}

it("isNest 调用直接跳过，不触发 vsigntool", async () => {
  await signWindowsHook({ path: "C:\\app\\ZCode.exe", isNest: true });
  expect(spawnSyncMock).not.toHaveBeenCalled();
});

it("非 PE 二进制（Mach-O/ELF）跳过签名，不触发 vsigntool", async () => {
  const machO = await createTempFile(
    "sharp-darwin-arm64.node",
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x00]),
  );
  const elf = await createTempFile("sharp-linux-x64.node", Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  try {
    await signWindowsHook({ path: machO });
    await signWindowsHook({ path: elf });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  } finally {
    await cleanupTempFile(machO);
    await cleanupTempFile(elf);
  }
});

it("PE（MZ）文件正常交给 vsigntool 签名", async () => {
  const exe = await createTempFile("ZCode.exe", Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
  spawnSyncMock.mockReturnValue({ status: 0 });
  try {
    await signWindowsHook({ path: exe });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnSyncMock.mock.calls[0] as unknown as [string, string[], unknown];
    expect(command).toBe("powershell.exe");
    expect(args).toContain("-FilePath");
    expect(args).toContain(exe);
  } finally {
    await cleanupTempFile(exe);
  }
});

it("vsigntool 失败时抛出包含文件路径的错误", async () => {
  const dll = await createTempFile("koffi.node", Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
  spawnSyncMock.mockReturnValue({ status: 1 });
  try {
    await expect(signWindowsHook({ path: dll })).rejects.toThrow(dll);
  } finally {
    await cleanupTempFile(dll);
  }
});

it("isWindowsPortableExecutable 按魔数判定；确认非 PE 与读取失败严格区分", async () => {
  const pe = await createTempFile("pe.node", Buffer.from([0x4d, 0x5a]));
  const machO = await createTempFile("macho.node", Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  const truncated = await createTempFile("short.node", Buffer.from([0x4d]));
  try {
    await expect(isWindowsPortableExecutable(pe)).resolves.toBe(true);
    await expect(isWindowsPortableExecutable(machO)).resolves.toBe(false);
    // 成功读取且不足 2 字节：确认不可能是 MZ，按非 PE 处理。
    await expect(isWindowsPortableExecutable(truncated)).resolves.toBe(false);
    // 读取失败（文件不存在、路径是目录、权限/IO 错误）必须抛错，
    // 不能与“确认非 PE”混同——否则 PE 会带着签名成功的假象漏签（评审 CR-01）。
    await expect(isWindowsPortableExecutable(join(pe, "..", "missing.node"))).rejects.toThrow();
    await expect(isWindowsPortableExecutable(join(pe, ".."))).rejects.toThrow();
    // sign() 对读取失败同样向上抛，不调用 vsigntool 也不返回成功。
    await expect(signWindowsHook({ path: join(pe, "..", "missing.node") })).rejects.toThrow();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  } finally {
    await cleanupTempFile(pe);
    await cleanupTempFile(machO);
    await cleanupTempFile(truncated);
  }
});
