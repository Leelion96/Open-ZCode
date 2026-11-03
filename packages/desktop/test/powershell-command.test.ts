import childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  verifyWindowsAuthenticodeSignature,
  createEncodedPowerShellArgs,
  createWindowsPowerShellSecurityArgs,
} from "../scripts/powershell-command.mjs";

function decodeCommand(args: string[]): string {
  expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  expect(args).toHaveLength(5);
  return Buffer.from(args[4]!, "base64").toString("utf16le");
}

describe("powershell-command", () => {
  it("把动态值编码进脚本且不再依赖普通 -Command 的尾随参数", () => {
    const values = ["C:\\Program Files\\Z'Code;测试\\helper.exe", "value with spaces & symbols"];
    const args = createEncodedPowerShellArgs(
      "[Console]::Out.Write($zcodeArg0 + '|' + $zcodeArg1)",
      values,
    );

    const command = decodeCommand(args);
    expect(command).not.toContain("$args");
    for (const [index, value] of values.entries()) {
      expect(command).not.toContain(value);
      expect(command).toContain(`$zcodeArg${index}=`);
      expect(command).toContain(Buffer.from(value, "utf8").toString("base64"));
    }
  });

  it("从 PSHOME 显式加载 Windows PowerShell Security 模块", () => {
    const command = decodeCommand(
      createWindowsPowerShellSecurityArgs("[Console]::Out.Write('loaded')"),
    );

    expect(command).toContain(
      "[IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security'",
    );
    expect(command).toContain("Import-Module -Name $zcodeSecurityModule -Force -ErrorAction Stop");
    expect(command).toContain("Windows PowerShell Security module load failed");
    expect(command).toContain("exit 26");
    expect(command).not.toContain("$env:PSModulePath");
    expect(command).toContain("$ProgressPreference='SilentlyContinue';");
    expect(command.indexOf("$ProgressPreference='SilentlyContinue'")).toBeLessThan(
      command.indexOf("Import-Module"),
    );
  });

  it.runIf(process.platform === "win32")(
    "Windows PowerShell 能还原带空格和脚本元字符的动态值",
    () => {
      const values = ["C:\\Program Files\\Z'Code;测试\\helper.exe", "value with spaces & symbols"];
      const output = execFileSync(
        "powershell.exe",
        createEncodedPowerShellArgs(
          "[Console]::Out.Write($zcodeArg0 + [Environment]::NewLine + $zcodeArg1)",
          values,
        ),
        { encoding: "utf8" },
      );

      expect(output.split(/\r?\n/)).toEqual(values);
    },
  );

  it.runIf(process.platform === "win32")(
    "Windows PowerShell 在 PSModulePath 被污染时仍加载系统 Security 模块",
    () => {
      const output = execFileSync(
        "powershell.exe",
        createWindowsPowerShellSecurityArgs(
          [
            "$signature=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $zcodeArg0;",
            "[Console]::Out.Write($null -ne $signature)",
          ].join(""),
          [process.execPath],
        ),
        {
          encoding: "utf8",
          env: { ...process.env, PSModulePath: "Z:\\zcode-invalid-psmodulepath" },
        },
      );

      expect(output).toBe("True");
    },
  );
});

// 工程适配器回归：仅替换系统进程，真实执行编码、结果解析及失败传播。
describe("Windows Authenticode 有效性校验", () => {
  it.runIf(process.platform === "win32")(
    "原生签名查询不会把首次模块加载进度误判为错误",
    async () => {
      const file = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      expect(await verifyWindowsAuthenticodeSignature(file)).toBeNull();
    },
  );

  it.each(["CN=Original Publisher, O=Original, C=US", "CN=Renewed Publisher, O=Changed, C=GB"])(
    "有效签名不受发布者 DN 限制：%s",
    async (subject) => {
      const spy = vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1) as (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
        callback(null, JSON.stringify({ status: 0, subject }), "");
        return {} as childProcess.ChildProcess;
      });
      try {
        expect(
          await verifyWindowsAuthenticodeSignature("C:\\Program Files\\Example';&.exe"),
        ).toBeNull();
        const args = spy.mock.calls[0]![1] as string[];
        const command = decodeCommand(args);
        expect(command).toContain("Get-AuthenticodeSignature -LiteralPath $zcodeArg0");
        expect(command).not.toContain("Example';&.exe");
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each([
    { status: 2, subject: "CN=Unsigned" },
    { status: 1, subject: "CN=Tampered" },
    { status: 0, subject: "" },
    { status: "0", subject: "CN=Malformed" },
  ])("拒绝无效签名或畸形结果：%j", async (result) => {
    const spy = vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void)(
        null,
        JSON.stringify(result),
        "",
      );
      return {} as childProcess.ChildProcess;
    });
    try {
      expect(await verifyWindowsAuthenticodeSignature("C:\\example.exe")).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("系统查询失败不放行", async () => {
    const spy = vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void)(
        new Error("PowerShell unavailable"),
        "",
        "",
      );
      return {} as childProcess.ChildProcess;
    });
    try {
      await expect(verifyWindowsAuthenticodeSignature("C:\\example.exe")).rejects.toThrow(
        "PowerShell unavailable",
      );
    } finally {
      spy.mockRestore();
    }
  });
  it("实际 stderr 仍拒绝，不能把进度静默扩大为忽略错误", async () => {
    const spy = vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void)(
        null,
        JSON.stringify({ status: 0, subject: "CN=Example" }),
        "actual module error",
      );
      return {} as childProcess.ChildProcess;
    });
    try {
      await expect(verifyWindowsAuthenticodeSignature("C:/example.exe")).rejects.toThrow(
        "actual module error",
      );
    } finally {
      spy.mockRestore();
    }
  });
});
