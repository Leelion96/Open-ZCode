# 3.16.2 远程（SSH）会话卡顿：根因与优化方案

Status: in-progress

P0-1 已实施（见下文 P0-1「实施结果」）。P0-2、P1-2 仍等待下文「待确认决定」中的产品决定，确认后按 spec → 测试 → 实现的顺序实施。

## 范围

- 现象：升级到 3.16.2 后，远程（SSH）会话明显卡顿。按回车后约 200ms 以上消息才发出。客户端与服务器在同一内网，3.15.3 没有这个问题。
- 本文只覆盖性能问题。断连另行跟踪，不在本文范围。
- 对比版本：`v3.15.3` → `v3.16.2`。
- 修复可能以 hotfix 发布。代码行号以 `release/v3.16.2` 的 `2469e25346` 为准。修复合入后要同步回 staging，staging 上的行号不同。
- 证据：
  - 用户提供的 Windows 客户端日志（2026-10-19～10-21，包含 main、host、renderer）。10-20 21:42 从 3.15.3 升级到 3.16.2，可以直接做前后对比。
  - 远端主机上 zcode-cli 的 agent 日志。只有 agent 事件，没有 Server Core 的服务端日志。

## 结论

1. 卡顿来自 3.16 的两个独立问题。共同点是：远端一次往返的成本被放进了高频路径。
   - **问题 1**：发送前先等一次远端查询（2 次串行 SSH 往返），只为了拿到项目 ID。
   - **问题 2**：侧栏频繁全量读取远端项目树。每次读取后，还要对每个路径再查一次远端工作区身份。
2. 收益最大、改动最小的一步，是**在桌面端按连接缓存远端身份登记**（P0-1）。它不改协议，也不改界面行为，同时减轻问题 1 和问题 2。
   - 依据：远端返回的身份是本地按 `serverId + workspacePath` 拼出的确定值（`packages/desktop/src/host/index.ts:3901-3916`）。远端调用只为了登记 stable → canonical 映射（`packages/services/src/node.ts:3237-3244`）。这个映射在同一个服务端进程内是幂等的，但现在每次读侧栏、每次发送都会重新登记一遍。
3. 侧栏读取挤占对话通道，目前只有相关性证据，没有因果证明。原因见下文「日志统计」。

## 证据

### 代码

**问题 1：发送路径**

- 3.16.2 的 `dispatchCommand` 在创建 envelope 之前，先执行 `await projectService.resolveSessionDirectories(...)`（`packages/ui/src/v4/SessionPane.tsx:2094`）。创建 envelope 在 `:2118`，显示发送中在 `:2194`。3.15.3 的同一函数没有这一步。
- 一次 resolve 内部有 2 次串行远端往返：
  1. 远端 repo 查询。
  2. `bindRemoteProjectIdentities` 中的 `resolveIdentity`（`packages/services/src/project/index.ts:320-327`）。
- UI 只用返回的 `projectId`，`workspaceIdentity` 被丢弃。
- 相关提交：
  - `6fe6cc1450`：引入接口。
  - `1204890243`：给 resolve 补了身份查询，形成第 2 次往返。
  - `3d4ff234f0`：按项目隔离草稿，发送前等待这次查询。
  - `1109f0fa9f`：辅助对话按 rootSessionId 查询。
- 设计意图见 [项目与未归类任务的草稿生命周期](../../ui/project-task-draft-lifecycle.md)「默认配置」一节：Recent 按项目隔离。

**问题 2：侧栏读取路径**

- 读取者：`readProjectSidebarTree`（`packages/ui/src/project-sidebar/project-tree-reader.ts`）。每一轮会做下面这些事：
  - 读本地树，再读**所有**远端主机的树（`:17`），包括离线主机。离线主机的失败结果本来就被忽略。
  - 带 `includeDeletedTasks: true` 读取。
  - 读取后对每个远程入口串行调用 `refreshEntry`（`:38`）。
  - 前后各读一次 `readDirectory`。
- 单次远端读取的代价：远端 readTree 返回后，对 N 个去重路径（项目 roots ∪ 任务 cwd）各发一次 `resolveWorkspace`，用 `Promise.all` 并发，没有缓存（`packages/services/src/project/index.ts:287-306`）。
- 远端每次 `resolveWorkspace`（`packages/services/src/session/sourceServerWorkspaceAliasRepo.ts:344-511`）都会：
  - 同步 `new DatabaseSync()` 打开任务库和会话库。
  - 执行 `runTasksDatabaseMigrations` 和 `runSessionDatabaseIdentityMigration`。
  - 做多次查询，以及一次 `markFailedPathResolved` 写入。
- 触发源（`packages/ui/src/project-sidebar/useProjectTree.ts`）：
  - `version`、`tabs`、`directoryRevision`（`:244`）
  - focus（`:304`）
  - 项目变化广播（`:314`）
  - 未读和已读写入之后的 `latestRefresh()`（`useProjectUnreadSignals.ts:113/156/217/341`）
- 合并机制只有 single-flight 加 dirty 标记，没有按 host 增量读取。
- 已确认的多余触发：
  - `ensureWorkspaceTab` 在内容没有变化时也返回新的 `tabs` 数组（`packages/ui/src/store/tabStore.ts:378`）。
  - 没有 live activity 的 Controller 行，`updatedAt`、`status` 一变就会增加 `directoryRevision`（`packages/ui/src/v4/windowControllerTaskListRegistry.ts:44-55`）。
- 共享资源：每个 Source 连接是一条 SSH channel 上的一个 WS，没有优先级。远端的项目读取、alias repo 和对话帧转发在同一个 Node 事件循环里。
- 相关提交：
  - `6fe6cc1450`：全量读取和逐任务身份查询。
  - `3cb3fb8898`：查询范围扩大到项目 roots，新增未读、已读触发。
  - `ba805061e7`：远端 alias repo，每次调用打开数据库。
  - `dc16292fa1`：每次调用执行迁移检查。

### 日志统计（3.16.2 段，约 12 小时）

| 项目                        | 实测                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `project.readTree` 总数     | 1453 次 = 远端 504 + 本地 370 + 离线失败 579                                         |
| 远端 readTree 耗时          | p50 103ms，p90 121ms，最大 171ms                                                     |
| 侧栏读取轮次                | 210 次触发产生 370 轮读取                                                            |
| 连发                        | 70% 的轮次落在 1.5 秒内的连发中（每次连发 2–6 轮）；最多每分钟 12 轮                 |
| 每轮的远端 readTree         | 平均 1.36 次（有时两台主机同时在线）                                                 |
| 离线主机读取                | 579 次，全部在本地直接失败（`project.host-offline`），属于无效调用                   |
| `resolveSessionDirectories` | 36 次，p50 89ms（88–97ms）；3.15.3 没有这个调用                                      |
| 典型连发                    | 一轮对话结束，`window-controller.mutateTask`（写未读）之后 600ms 内连续读了 3 轮全量 |

连发前最近的 RPC（启发式归因，需要 renderer 日志确认）：

| 前一个 RPC                             | 次数 |
| -------------------------------------- | ---- |
| `window-controller.listTaskList`       | 64   |
| `window-controller.mutateTask`         | 63   |
| `zcode-task.getTaskMeta`               | 47   |
| `source-server-management.getSnapshot` | 27   |
| `task-groups.admit`                    | 14   |

**挤占对话的相关性。** 按"请求开始时是否有远端 readTree 在途"分组，对比远端 RPC 的耗时：

| 调用                        | 有 readTree 在途 | 无 readTree 在途         |
| --------------------------- | ---------------- | ------------------------ |
| `sendConversationCommandV4` | n=6，p50 891ms   | n=50，p50 59ms，p90 96ms |
| `conversationRowsRangeV4`   | n=3，p50 89ms    | n=66，p50 45ms           |

这组数据有干扰因素。超过 900ms 的几次发送都发生在新建任务或切换工作区时。同一时刻还有一批远端请求在并发，例如 `subscribeSessionsIndexV4` 约 700ms，`readWorkspacePresentation` 约 850ms，`client-scenes.list` 约 300ms。readTree 只是其中之一。所以只能说：远端单通道上的突发并发拖慢了发送，侧栏读取是其中最频繁的参与者。远端订阅变慢（p90 从 171ms 升到 789ms）和 readTree 在途没有明显关系，原因待查（见 P2）。

## 链路

### 问题 1：发送

```text
现在（3.16.2）
  回车
   └▶ await resolveSessionDirectories
        ├─SSH─▶ 远端 repo 查询项目           ≈45ms
        └─SSH─▶ 远端 resolveWorkspace         ≈45ms（返回的身份被丢弃）
   └▶ 创建 envelope → 登记恢复账本 → 显示发送中
   └▶ send ─SSH─▶ ack                        30–70ms
   └▶ accepted 后写 Recent

P0-2 之后
  回车
   └▶ 从窗口目录树同步读取该任务的 projectId（0 次往返；目录树缺行时才退回远端查询）
   └▶ 创建 envelope → 登记恢复账本 → 显示发送中
   └▶ send ─SSH─▶ ack
   └▶ accepted 后写 Recent
```

### 问题 2：侧栏读取

```text
现在（3.16.2）
  触发：写未读/已读 · Controller delta · focus · tabs · 项目变化
   └▶ refresh（single-flight + dirty；连发时一轮接一轮）
        ├ readDirectory
        ├ 本地 readTree
        ├ 每个远端主机 readTree（离线主机：本地直接 FAIL）
        │    └ 远端返回后，对 N 个路径各发 1 次 resolveWorkspace
        │         └─SSH─▶ 远端每次同步打开 2 个库 + 迁移检查 + 1 次写入
        ├ 每个远程入口 refreshEntry（串行）
        └ readDirectory

目标
  同一件事只触发一轮 → 只读在线主机（按 delta 只读受影响的主机）
   └ 远端 readTree ─SSH─▶ 1 次往返
   └ resolveIdentity：本连接已登记的路径直接命中缓存；只有新路径才发到远端
```

## 优化方案

### P0-1　桌面端按连接缓存身份登记

- **做法**：
  - 在 `resolveProjectHostService` 传给 `bindRemoteProjectIdentities` 的 `resolveIdentity` 外层加缓存（`packages/desktop/src/host/index.ts:3872`、`:3901`）。
  - 缓存的 key 是当前在线连接对象，值是 `Map<workspacePath, Promise<identity>>`。
  - 调用失败时删除这条缓存，下次重试。失败语义和现在相同：任一路径失败时，该主机的 readTree 失败。
- **为什么安全**：
  - 每条物理连接都会发布新的 `OnlineConnection` 对象（`packages/desktop/src/host/sourceServerConnectionManager.ts:1120`），重连后旧缓存自然失效。
  - 服务端进程重启一定会断开 WS，所以同样会换新对象。
  - 映射一旦建立，canonical key 不变（`resolveCanonicalWorkspaceKeyInternal` 的 existing alias 分支）。
- **收益**：
  - 远端 readTree 每轮只剩 1 次往返，远端不再频繁打开数据库。
  - `resolveSessionDirectories` 从 2 次串行往返降为 1 次（约 89ms → 约 45ms）。
  - `prepareSession` 同样受益。
- **行为变化（需要确认）**：旧版客户端写入的同路径 legacy variant，合并时机从"下次读侧栏时"变为"下次连接时"。只有新旧版本客户端同时连接同一台主机才会遇到。
- **实施结果（2026-10-21）**：
  - 规则写入 [远程导航 spec §2.1b](../../remote/project-first-remote-navigation-spec.md) 与 `packages/services/src/project/CONTRACT.md`。实现是 `createRemoteIdentityRegistrationCache`（`packages/services/src/project/index.ts`），在 `resolveProjectHostService` 的两条分支装配。
  - 对原方案的两处修正：
    1. 缓存 key 用物理连接（Registry 分支用 `physicalOwner()`，Manager 分支用 `connection.services`）。Registry 的 handle 在 Source 重连后不换新对象（`host/index.ts` 的 `onDidReconnect` 只替换内部 connection）。如果用 handle 做 key，Core 重启后新映射表收不到登记。真实模块探针证明了这一点：新 Core 的映射表为 0 条。
    2. 两条分支分开缓存。Registry 分支带 Host 目录的 legacy hint，Manager 分支不带。共用缓存可能跳过带 hint 的那次登记。
  - 行为变化比上文写的小：工作区打开（`prepareWorkspaceIdentity`）不经过缓存，仍按 R3 §9.2 在打开时合并。所以合并时机是"下次打开该工作区或下次连接时"。

### P0-2　发送不再等待远端查询

- **做法**：
  - `SessionPane` 已经拿到 `useOptionalProjectDirectory()`（`SessionPane.tsx:1908`）。它的 `factTree.tasks[].projectId` 来自 Host 权威组织态。
  - 发送时按任务地址同步读取 projectId。辅助对话仍然按 `rootSessionId` 查询所属的主会话。
  - 只有目录树里找不到这条任务时，才退回现在的 `resolveSessionDirectories`。
- **时序**：归属在发送那一刻同步冻结，然后登记恢复账本。这满足「必须早于第一次上行」（`SessionPane.tsx:2133`）。切页和迟到的 ACK 不能改写归属。
- **不采用的方案**：把查询挪到 ACK 之后并行执行。恢复账本要求第一次上行前就固化 scope，那样改会多出一套"scope 未定"的状态，渲染进程刷新后还需要额外处理。
- **行为变化（需要确认）**：
  - [草稿生命周期 spec](../../ui/project-task-draft-lifecycle.md) 现在写的是"从权威组织态读取归属"（`:47`）。要改成"读取窗口目录已接收的权威组织态；目录缺行时再向所属 Host 查询"。
  - 代价：任务刚在两个项目之间移动后，在一个读取周期内（约 100ms），Recent 可能记到旧项目上。

### P1-1　侧栏只读在线主机

- **做法**：`readProjectSidebarTree` 只对 `connectionStatus === "online"` 的主机发起 readTree。
- 离线主机原来就显示入口缓存（`mergeProjectTrees` 用入口缓存补齐没有读到的主机）。
- 与 staging 的差异：release 上，离线主机的读取失败也会记进 `errors`（`project-tree-reader.ts:28-33`）。staging 由 `550995edea` 改为只记录读取开始时在线的主机，修掉了"连接过程中误显示连接失败"。跳过离线主机后，离线主机不再产生失败记录，效果包含 `550995edea` 的修复。实施时以 `550995edea` 的 spec 语义为准，两者合并到 staging 时不能冲突。
- **前提**：主机上线时一定会触发一次读取（Controller workspaces topic 或项目变化广播）。实施时需要用单测锁住这一点，否则跳过离线主机后，上线的主机要等下一次触发才显示远端树。
- **收益**：去掉 579 次无效调用（12 小时）。

### P1-2　合并连发读取

- 70% 的连发说明，同一件事产生了多个触发。例如一轮对话结束时，写未读后的 `latestRefresh()`、Controller delta 和 focus 各触发一次。
- 不用定时防抖。方向是找唯一数据源：
  - Controller frame 已经会带来这次变化时，去掉写入后那次重复的 `refresh`。
  - 按 delta 的 host 只读受影响的主机。
  - `ensureWorkspaceTab` 在没有变化时返回原数组。
- **前置步骤**：
  1. 在 renderer 用 `packages/ui/src/logger.ts` 的 `debug` 记录每次 `refresh` 的触发源。
  2. 在开发构建中接远程测试机复现，确认实际的触发分布后再定方案。
- **预期**：读取轮次从 370 降到约 210（按连发合并估算）。

### P2　后续项

- **远端 `SourceServerWorkspaceAliasRepo`**：复用数据库连接，迁移检查只做一次。有了 P0-1 之后，只影响连接后第一次读取，所以优先级降低。
- **远端订阅**：`subscribeConversationV4`（`packages/services/src/zcode-agent/zcodeAgentService.ts:5978` 起）有 3 段串行等待：provider 同步、父链 `sessionList`、目录解析。ack 中已经有 `openTiming` 分段数据，但日志没有记录。先在每次订阅时记下 `openTiming`，再判断瓶颈。
- **未验证的猜测**：局域网内远端 RPC 最快也要约 40ms，两个版本都是这样，所以不是本次回归。可能是 SSH exec 通道和 `proxy-stdio` 的 loopback socket 没有关闭 Nagle（`packages/zcode-server-cli/src/server-core/proxyStdio.ts:39` 没有设置 `noDelay`）。可以单独做一次实验验证。

## 预期效果（估算）

| 路径               | 现在                               | 优化后                      |
| ------------------ | ---------------------------------- | --------------------------- |
| 回车到显示发送中   | ≈90ms                              | ≈0ms（目录树缺行时约 45ms） |
| 每轮侧栏的远端开销 | 1 + N 次 RPC，远端打开 2N 次数据库 | 1 次 RPC                    |
| 离线主机读取       | 579 次 / 12h                       | 0                           |
| 侧栏读取轮次       | 370                                | 约 210（待 P1-2 日志确认）  |

## 待确认决定

1. **P0-1**：已按用户要求实施。合并时机为"下次打开该工作区或下次连接时"，见 P0-1「实施结果」。
2. **P0-2**：Recent 归属改为同步读取窗口目录树（缺行时才查询 Host），并更新草稿生命周期 spec，能否接受？
3. **P1-2**：先补触发源日志、在远程测试机上复现，再决定合并方案，能否接受？

## 实施与验证计划

- 顺序：P0-1 → P0-2 → P1-1 → P1-2 → P2。每一项先改 spec，再写测试，最后实现。
- **P0-1**：
  - 单测锁住三点：同一连接内同路径只发 1 次远端登记；失败不缓存；新连接对象重新登记。
  - 运行时对比远端 readTree 和 `resolveSessionDirectories` 的耗时。
- **P0-2**：
  - 单测锁住时序：命中目录树时，发送前不调用 `resolveSessionDirectories`；缺行时退回查询。
  - 补远程发送路径的 E2E。
  - 用 CDP 或日志实测回车到显示发送中的耗时。
- **P1-1 / P1-2**：单测锁住"离线主机不发 readTree"，以及"同一件事只读一轮"。
- 每项都执行：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`pnpm test:unit:affected`。涉及交互时加对应的 E2E。

## 统计方法

- 按 `electron initialized env=prod version=` 切分版本段。
- 用正则 `\[rpc:call\] (\S+) (OK|FAIL) \(([\d.]+)ms\)` 提取方法、结果和耗时，开始时间取 host 内层时间戳减去耗时。
- `project.readTree`：
  - OK 且大于 30ms 记为远端，小于等于 30ms 记为本地，FAIL 记为离线主机。
  - 每次本地 readTree 算作一轮侧栏读取。
  - 相邻两轮间隔小于 1.5 秒，算作同一次连发。
- 判断"有 readTree 在途"时，按请求的开始时刻分组，不按区间重叠分组。按区间重叠分组会偏向耗时长的请求，导致结果失真。

## Comments

### 2026-10-21 P0-1 根因确认与验证

- 根因：`resolveProjectHostService` 每次调用都新建 resolver，没有记忆。`bindRemoteProjectIdentities` 在每次 readTree、`resolveSessionDirectories`、`prepareSession` 中，对每个路径重新发起远端 `resolveWorkspace`。这个登记只写入 Core 进程内的映射表，同一连接内重复登记是幂等的。引入提交：`6fe6cc1450`、`1204890243`、`3cb3fb8898`，都在 v3.16.2 中，v3.15.3 没有。
- 复现：真实模块探针（`bindRemoteProjectIdentities` + `SourceServerWorkspaceAliasRepo` + `createSourceServerWorkspaceService` + `SourceServerWorkspaceIdentityMapper`，临时 SQLite，模拟 RTT 40ms，6 个路径）。
  - 修复前：10 轮 readTree 加 5 次 `resolveSessionDirectories` 共 65 次远端登记。readTree p50 92–103ms，`resolveSessionDirectories` p50 86–100ms，与用户日志（103ms / 89ms）一致。重复登记后 `workspace_alias` 不变。服务端单次同步执行 p50 8.9ms。
  - 修复后（真实 helper）：同一连接只登记 6 次，之后 0 次。readTree 和 `resolveSessionDirectories` p50 都是 41ms（1 次往返）。新连接会重新登记；失败后会重试。
- 验证：`pnpm typecheck` 通过；`pnpm lint` 0 errors；改动文件 `oxfmt --check` 通过；`pnpm architecture:check --changed` OK；`pnpm test:unit:affected --base 2469e25346` 105 个文件、1402 个测试通过。
- 未验证：真实用户主机上的端到端耗时（下方 E2E 用本机 Docker 模拟远端）。

### 2026-10-21 P0-1 SSH E2E 验证

- 环境：macOS arm64 Desktop；远端是 `harness/remote` 镜像 `zcode-remote-ssh:test` 的新容器（每次运行重建）；用例 `conversation-session-ssh-remote-p0`（A/B 两个工作区，共 4 次发送）。基线是 `0da8590ddb~1`，修复是 `0da8590ddb`。两版都在 Host 实际发出远端登记处加了同样的临时日志，测完已删除。
- 交替 A/B（直连，同一时段）：修复 4/4 通过；基线 3/4 通过。
- 每个用例的远端登记次数：基线 49–51 次；修复 3 次（每个物理连接、分支、路径各 1 次）。
- 模拟局域网延迟（安装完成后每方向 20ms，RTT 约 40ms）：

  | 指标                                    | 基线         | 修复                    |
  | --------------------------------------- | ------------ | ----------------------- |
  | 远端 `project.readTree` p50             | 98–99ms      | 45–54ms                 |
  | `project.prepareSession` p50            | 90ms         | 45ms                    |
  | `project.resolveSessionDirectories` p50 | 122ms（n=2） | 90ms（n=2，非交替样本） |

- 失败分析：两版都出现了同样的失败，失败原因与本次改动无关。
  - 远程项目创建后会自动打开；如果自动打开还没有收到 renderer attachment，用户（或用例）又点击了"新建任务"，第二次打开会加入同一个 route。`desktopRemoteSessions.ts` 的 `waitForRendererAttachmentReady` 立即拒绝（"尚无可用 renderer attachment"），随后共享会话被释放，工作区一直打不开。基线和修复都复现过。这是另一个已有问题，未在本次处理。
  - 加延迟后，切回任务时 `remoteSessionId` 被重建，`waitForRemoteTab` 不收敛。基线和修复各出现 1 次。
  - 早期几次失败来自默认 120s 用例上限（需要与 harness 一样设置 `ZCODE_E2E_MANUAL_REVIEW_HOLD_MS`），以及 SSH 连接前的 UI 点击失败。这些都不涉及本次改动的代码路径。
