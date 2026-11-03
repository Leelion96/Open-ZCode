export function buildTerminalProbeCommand(label: string, target: "local" | "linux-ssh"): string {
  // 本地终端可能是 PowerShell，不能依赖 printf/$$；远端 Linux 则不要求安装 Node。
  // 标记在输入中拆开，并在 cwd 之后输出，避免输入回显或旧 cwd 使等待提前完成。
  if (target === "local") {
    return `node -e "console.log('PTY_OWNER='+process.ppid);console.log(process.cwd());console.log('E2E_'+'MRO04_${label}')"`;
  }
  return `printf 'PTY_OWNER=%s\\n' "$$"; pwd; printf 'E2E_%s\\n' 'MRO04_${label}'`;
}
