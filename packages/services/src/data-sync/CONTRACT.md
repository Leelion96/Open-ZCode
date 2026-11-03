# data-sync-service

数据同步（`docs/remote/data-sync.md`）的服务侧：各分类在两端实现同一组方法，Renderer 用本机 base services 作为 source、设备的 source-settings attachment 作为 target，比较在 Renderer 纯函数中完成。

- `IDataSyncCategoryService<TPayload>`：`listSyncItems` / `getSyncContentHashes` / `checkSyncWriteAccess` / `exportSyncItems` / `importSyncItems`。分类服务（技能、MCP、插件……）在自己的通道上实现这组方法；技能实现见 `skillDataSync.ts`，由 `createSkillSyncService` 组合进 `skill-sync` 通道。inline 插件实现见 `inlinePluginDataSync.ts`（key `name@inline` 小写，排除插件目录顶层 `data/`），由 `createPluginSyncService` 组合进 `plugin-sync` 通道。 MCP 实现见 `mcpDataSync.ts`，由 `createMcpSyncService` 组合进 `mcp-sync` 通道。
- `IUserConfigSyncService`（通道 `user-config-sync`）：子智能体、命令、钩子共用一个通道，方法同上，每个方法多一个 `category` 参数（`UserConfigSyncCategory`）。`userConfigSyncService.ts` 按 category 分派，未知 category 报错；子智能体实现见 `subagentDataSync.ts`；命令实现见 `commandDataSync.ts`（合并 `~/.zcode/commands` 与 `~/.agents/commands`，`.zcode` 优先，统一写入 `~/.zcode/commands`）。两端都经 `createLocalServices` 注册，加入远程 workspace RPC 合同、source-settings 集合和远端 bundle 标记，不进手机白名单。
- 公共入口：`index.ts` 只导出契约（Renderer 可用）；`node.ts` 导出实现（Host / Server）。
- `IDeviceSyncStateService`：本机 Host 按 sourceServerId 记录 `lastSyncAt` / `lastResult`，文件为 `<appConfigDir>/data-sync-state.json`。

不变量：

- 推送永不删除目标端独有的条目；`importSyncItems` 只处理 `items` 中列出的 key。
- `overwrite` 必须带 `expectedTargetHash`；目标端导入前重新计算哈希，不一致返回 `conflict`，不写入。`createOnly` 遇到目标端已有同 key 也返回 `conflict`。
- 目录类覆盖：同盘临时目录解压 → 原目录改名为备份 → 新目录改名到位；失败还原备份。
- 目录类覆盖前，先检查目标端是否有其他条目位于被覆盖目录之内（技能比较 `directoryPath`，inline 插件比较 `configuredPath`）。有则该项 `failed`，原因写明被包含的条目路径，不替换目录。这项检查在哈希检查之前，因为父目录的哈希包含子目录，`expectedTargetHash` 防不住。
- 启用状态：新建带来源状态（键换算为目标端路径），更新保留目标端状态。新建项只在来源状态与目标端当前状态不一致时写配置（来源启用时删除目标端残留的禁用项）。
- 技能嵌套：`listSyncItems` 给出 `parentKey`（同端内目录包含它的最近技能）；`exportSyncItems` 只打包最上层的选中目录；`importSyncItems` 按来源目录层级先上级后下级处理，下级位于本次已写入的上级之内时随上级写入（目标端原无该 key → `created`；原有该 key → `failed`，不覆盖）。
- 需要路径改写的分类在 `getSyncContentHashes({ keys, targetHomeDir })` 中按目标端路径计算来源端哈希；`listSyncItems` 的 `importBlockedReason` 表示该端作为目标时整类不能导入。
- 设备同步状态只在本机 Host 注册，不进入远程 workspace RPC 合同、source-settings 服务集合和手机白名单。
