# 10: 命令分类

Status: done

**Parent:** [数据同步：把本机配置推送到远端设备](../../remote/data-sync.md)

**What to build:** 用户可以在数据同步弹窗中把本机的 User 级自定义命令推送到远端，并在概览中看到命令一行。

- 本机来源包括 `~/.zcode/commands` 和 `~/.agents/commands`，两者合并，同名时 `.zcode` 优先。结果统一写入远端 `~/.zcode/commands`。
- 命令按相对路径对齐（例如 `/git/commit`），按原文件推送，子目录结构保持不变。
- 本机禁用的命令推送到远端后仍然是禁用状态；更新已有命令时保留远端的启用状态。
- 远端同名命令位于 `~/.agents/commands` 时，该项不能同步，并说明原因。

**Blocked by:** [01: config.json 写入加固](01-harden-user-config-writers.md)、[09: 子智能体分类与新同步通道](09-subagent-category-sync-channel.md)

## Acceptance criteria

- [x] 在 09 新增的同步通道中实现 commands category。
- [x] 来源为 `~/.zcode/commands` 与 `~/.agents/commands` 的合并（递归扫描，跳过 `.` 开头的条目）。合并规则与 CLI 运行时一致：同名时 `.zcode` 优先。目标端的列表按同一规则合并。
- [x] 所有命令统一写入远端 `~/.zcode/commands`。
- [x] 对齐 key 为去掉 `.md` 后的相对路径，格式为 `/git/commit`；原样复制文件字节，不经过表单保存接口。
- [x] 启用覆盖以绝对文件路径为键：新建项换算为目标端路径并带上来源状态；更新项保留目标端状态。写入 `config.json` 复用 01 加固后的写入路径。
- [x] 远端同名命令位于 `~/.agents/commands` 时，按覆盖的通用规则标为不能同步，并写明原因。其他命令不受影响，本分类不整体禁用。
- [x] 推送后刷新远端的 slash commands。
- [x] 中英文文案齐全。
- [x] 先补测试再改代码。

## Verification

- Seam ①：嵌套目录命令、两个来源目录的合并与 `.zcode` 优先、启用覆盖键的换算（含 Windows 来源到 POSIX 目标）、更新保留目标状态、远端同名项位于 `.agents` 时只禁用该项。
- Seam ③：推送一个子目录下的禁用命令和一个来自 `~/.agents/commands` 的命令，在远端 `~/.zcode/commands` 断言文件和禁用状态。
