# 07: inline 插件分类

Status: done

**Parent:** [数据同步：把本机配置推送到远端设备](../../remote/data-sync.md)

**What to build:** 数据同步弹窗新增「插件」分类和对应的概览行，本票先覆盖 inline 插件，即本机 `plugins.dirs` 中登记的插件目录。

- 按 `name@inline` 对齐，比较 Plugin Manifest 版本和目录内容哈希。
- 新建：写入远端 `~/.zcode/plugins`，并登记到远端的 `plugins.dirs`。
- 更新：原子替换插件目录，保留远端的 `data/`、启用状态和 options。
- 推送后，远端的技能、命令、MCP 和插件管理列表立即刷新。

**Blocked by:** [04: Tracer：数据同步页与技能推送](04-data-sync-page-skill-push.md)

## Acceptance criteria

- [x] 插件同步服务按统一形状扩展，inline 插件的 `list` 返回 pluginId、Plugin Manifest 版本、轻量签名、启用状态，以及能否同步和原因。
- [x] 对齐 key 为 `name@inline`（转小写）；目录名只表示位置，不作为对齐依据。
- [x] 导出时排除 `data/`。更新时先暂存，再改名交换并保留备份；目标端的 `data/`、启用状态和 options 保持不变。
- [x] 远端 `plugins.dirs` 中的同名插件如果指向远端 `~/.zcode/plugins` 以外的目录（例如开发中的 checkout），该项不可更新，并说明原因。
- [x] 新建时只同步安全子集的 options：已配置、非敏感、非文件 / 目录类型、类型与远端 schema 匹配的值；启用状态按通用规则处理。
- [x] 插件目录内有软链、或超过 50MB 上限时，该项显示为不能同步，并写明原因。
- [x] 写入远端 `plugins.dirs` 失败时，回滚已经写入的目录。
- [x] 推送后复用现有刷新逻辑：依次刷新技能、slash commands、MCP，并发送插件管理通知。
- [x] 中英文文案齐全。
- [x] 先补测试再改代码。

## Verification

- Seam ①：版本较新时更新、内容不同时显示差异、更新后 `data/` / 启用状态 / options 保留、外部目录不可更新、软链与超限、config 写入失败时回滚。
- Seam ②：插件分类的行状态、版本变化显示和不能同步原因。
- Seam ③：推送一个 inline 插件，在远端断言插件目录和 `plugins.dirs`；修改本机版本后再推送，断言远端完成更新且 `data/` 未变。
