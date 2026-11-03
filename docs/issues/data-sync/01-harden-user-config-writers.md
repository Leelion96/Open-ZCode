# 01: config.json 写入加固

Status: done

**Parent:** [数据同步：把本机配置推送到远端设备](../../remote/data-sync.md)

**What to build:** 用户在设置页修改命令启用状态、钩子或技能启用状态时，以及迁移向导导入 MCP 和插件目录时，如果用户级 `config.json` 已经损坏，操作失败并给出明确提示，不再把文件当作空配置写回，冲掉其中的 MCP、插件等其他配置。文件正常时，每次写入前重新读取最新内容，只改动自己负责的字段，再原子替换。设置页现有的保存行为和结果不变。后续同步票的覆盖写入都依赖这条写入路径。

**Blocked by:** None (can start immediately).

## Acceptance criteria

- [x] 命令、钩子、技能三处写入用户级 `config.json` 时，文件存在但 JSON 无效 → 返回错误，文件字节保持不变；设置页沿用现有失败反馈。
- [x] 迁移导入（`packages/services/src/settings-sync/settingsSyncService.ts`，写入 MCP 和 `plugins.dirs`）同样复用 `updateJsonObjectFile`：文件损坏时返回错误且字节不变；写前重读，只改自己的字段，原子替换。
- [x] 文件不存在时正常创建；文件为空对象时正常写入。
- [x] 写入前重新读取磁盘上的最新内容；最终文件中，其他写入方负责的字段（MCP、插件、其他分类）原样保留。
- [x] 写入采用临时文件加 rename 的原子替换；写入中途失败不留下半截文件。
- [x] 不新增跨进程锁，不增加重试或超时兜底。
- [x] 修复处用中文注释写明根因（读失败被当作空对象，导致整文件被覆盖）和修复方式。
- [x] 先补测试再改代码。

## Verification

- 服务层单测使用临时 HOME：损坏文件拒绝写入且字节不变；三处写入分别保留其他字段；依次写入两个分类后两个字段都在。
- 服务层单测：迁移导入遇到损坏的 `config.json` 时拒绝写入且字节不变；文件正常时保留其他字段。
- 命令、钩子、技能设置页和迁移向导现有的单测和 E2E 通过。

## Comments

- 2026-10-16 补充修复（decisions.md 第 16 条）：迁移导入 `settingsSyncService` 写 `config.json`（MCP `mcp.servers`、插件 `plugins.dirs`）改用 `updateJsonObjectFile`，用户级和项目级 `config.json` 都走这条路径；文件损坏时该项在迁移结果中标为失败，字节不变；插件登记失败时删除本次放入的插件目录，避免修好配置后重试被判成 targetExists。
