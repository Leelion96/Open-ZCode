# 06: MCP 服务器分类

Status: done

**Parent:** [数据同步：把本机配置推送到远端设备](../../remote/data-sync.md)

**What to build:** 数据同步弹窗新增「MCP 服务器」分类和对应的概览行。用户可以把本机「有效用户 MCP」推送到远端：

- 推送前，filesystem 类 MCP 的 `args` 中的本机 home 路径会改写为远端 home 路径。比较也在改写之后进行，所以 filesystem 类 MCP 不会因为路径不同被误判为不一致。
- 新建的 server 带上本机的启用状态；更新已有的 server 时保留远端的启用状态。
- env 和 headers 原样写入远端配置文件。MCP OAuth token 不同步，远端需要重新授权。
- 如果远端当前只在使用 `~/.agents/mcp.json` 兼容配置，本分类整体不能推送，并说明原因。

**Blocked by:** [04: Tracer：数据同步页与技能推送](04-data-sync-page-skill-push.md)

## Acceptance criteria

- [x] MCP 同步服务按统一形状扩展：`list`、`contentHashes`、`checkWriteAccess`、`export`、`import`（逐项 `createOnly` / `overwrite`，带 `expectedTargetHash`）。
- [x] 对齐 key 为 server name：比较时转小写，写入时保留原大小写。
- [x] 比较前对来源配置做目标端路径改写，再比较规范化的 JSON；比较时排除 `enabled` 和历史遗留的 `enable` 字段。
- [x] home 改写的范围保持现状：只改写 filesystem 类 stdio MCP 的 `args`，不改写其他 MCP 的 args、env、cwd。不论从哪个入口打开弹窗，都做 home 改写。
- [x] 导入参数改名为 `sourceHomeDir`、`sourceWorkspacePath`、`targetWorkspacePath`。本票只做 home 改写，workspace 改写在 14 接入。
- [x] 改写按目标路径风格（POSIX / Windows）拼接。
- [x] 更新时只替换选中的 server，保留远端启用状态和其他字段；写入沿用现有的严格读取、原子写入和 0600 权限。
- [x] 远端 `.zcode` 中没有任何 server、实际生效的是 `~/.agents/mcp.json` 时，本分类所有行都不可选，原因写「远端使用 ~/.agents 兼容配置，推送会使其失效」。
- [x] 推送后刷新远端的 MCP 列表。
- [x] 中英文文案齐全。
- [x] 主进程 MCP 设置页写入方（`packages/desktop/src/main/mcpUserDirectory/index.ts` 的 `writeZCodeServersToFile`、`writeServerEnabledToFile`、`cleanupLegacyMcpEnabledOverride`）改为严格读取 + 写前重读 + 原子替换（0600）；文件损坏时拒绝写入且字节不变。单独一个 fix commit。
- [x] 先补测试再改代码。

## Verification

- Seam ①：路径改写后的比较（含 Windows 来源到 POSIX 目标）、非 filesystem 类 MCP 的字段不改写、新建带启用状态、更新保留目标启用状态、远端只有 `.agents` 时禁用、损坏的远端配置拒绝写入、`expectedTargetHash` 冲突。
- Seam ②：概览行和分类行状态、整类禁用的展示。
- Seam ③：推送一个 stdio MCP 和一个 filesystem MCP，在远端配置文件中断言内容和路径改写。
