# 并发导航进入同一远程项目时，共享会话被提前销毁

Status: ready-for-human

诊断基线 `5127628d4b`（数据同步集成分支）。环境：macOS Apple Silicon，本机 Docker 远端 runner（`harness/remote/run-local-docker.mjs`），linux/arm64 容器，test 远端包。方法：先跑未改动的基线，再在 renderer 加临时诊断日志并可选放大竞态窗口；诊断后已全部还原。原始运行工件未保留，下文日志为摘录。

结论：这是产品 bug，由两个缺陷叠加而成。保存远程项目后立即再点「新建任务」即可触发，用户操作与 E2E 用例都会遇到。缺陷 1 属于设计缺陷，修复前需要确认方案（建议方案 a）。数据同步 MR 不包含此修复（[数据同步规格](../../remote/data-sync.md)）。

## 1. 现象

保存远程项目以后，`remote-projects.connectHost` 在 300–500ms 内被调用两次。第一次连接的 renderer attachment 在 ready 后几毫秒内被 dispose（`remote-session-disposed, connections=0`）。最后没有一个远程 tab，`waitForRemoteTab` 超时，报错如下：

```
E2E_DSYNC_04_SKILL_PUSH: remote tab identity/session 没有收敛，latest={"activeWorkspaceIdentity":null,...,"remoteSessionId":null,...}
```

## 2. 复现率

| 运行                                              | 条件                 | 结果                                                                |
| ------------------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| SSH P0 连接（基线）                               | 单 runner            | 7/7 PASS                                                            |
| DSYNC-04（基线）                                  | 与另一个 runner 并发 | 4/4 PASS                                                            |
| DSYNC-07+08 同批（基线）                          | 单 runner，2 spec    | 4/4 PASS（8 次 spec 运行）                                          |
| DSYNC-07+08+04 同批（插桩，无延迟）               | 单 runner，3 spec    | 2/2 PASS                                                            |
| SSH P0（插桩，无延迟）                            | 与另一个 runner 并发 | 2/2 PASS（其中 1 次出现竞态但碰巧自愈）                             |
| DSYNC-04（插桩）                                  | 与另一个 runner 并发 | **FAIL**。失败发生在 bind 之前，延迟开关没有起作用，属于自然复现    |
| 3 个 runner 并发加压（P0×2、DSYNC-04×2、07+08×1） | 机器高负载           | **1/5 FAIL**（DSYNC-07，机理与上一行相同）                          |
| SSH P0（插桩，bind 后延迟 1000ms）                | 人为放大窗口         | 稳定复现「复用后被销毁」这一变体；用例仍 PASS（断言有缺口，见 5.3） |

- 所有运行（共 30 多次 spec 运行）**每次**都有两次 connectHost。只有两次导航在时间上重叠时才会失败。
- 重叠的概率随机器负载升高。负载高时 provider provisioning 首次同步从约 140ms 涨到 500–960ms（见证据 3.2），竞态窗口跟着变宽。各个 worktree 的 agent 同时跑 runner，正是这种高负载。
- 单 runner、无并发时，自然失败率低于 1/20。机器负载高时约为 1/5–1/3。

## 3. 证据

### 3.1 第二次 connectHost 是谁发起的

两次都进入 `startNewTaskFromActiveWorkspace`（日志中 source 都是 `"sidebar new task"`），`navigationSequence` 分别为 1 和 2：

```
03:19:54.670 [renderer] [DIAG] {"at":"ProjectCreation.saved->onCreateTask","projectId":"3bc2334f-..."}
03:19:54.670 [renderer] [DIAG] {"at":"startNewTask","source":"sidebar new task","sequence":1,...}   ← A：保存后自动选中项目
03:19:55.054 [renderer] [DIAG] {"at":"startNewTask","source":"sidebar new task","sequence":2,...}   ← B：用例点击 virtual-project-create-task
```

- A：`packages/ui/src/project-sidebar/ProjectCreation.tsx:172`。`saved()` 在项目保存后调用 `onCreateTask({projectId, hostId})`，即「创建后把草稿切到新项目」。
- B：`packages/desktop/test/e2e/helpers/ssh-remote-p0.ts:729`。`selectSSHRemoteDirectory` 在新项目行出现后，又点了一次 `virtual-project-create-task`。
- B 启动时会执行 `++navigationSequence`（`packages/ui/src/root/useRootWorkspaceActions.ts:215`、`:224`），之后 A 的 `isCurrent()` 一直返回 false。

### 3.2 自然失败时序（两次独立复现，形态相同）

```
03:19:54.733 [zcode-host] remote-projects.connectHost OK                      ← A
03:19:54.734 [zcode-host] connecting window-scoped remote source, requestId=6cb12fa7…
03:19:54.825 [zcode-host] window Host topology, reason=remote-connected, logicalSessions=1
03:19:55.119 [zcode-host] remote-projects.connectHost OK                      ← B（与 A 相隔 386ms）
03:19:55.121 [renderer] [DIAG] {"at":"attach.findSession",...,"existing":null}
03:19:55.123 [zcode-host] connecting window-scoped remote source, requestId=806bbcce…
03:19:55.158 [error] [main] [connect-remote] caught error: {"message":"远程 workspace route 尚无可用 renderer attachment，sessionId=[redacted]",...}
03:19:55.162 [renderer] [DIAG] {"at":"startNewTask.catch","sequence":2,"current":true,"error":"Error: 远程 workspace route 尚无可用 renderer attachment…"}
03:19:55.326 [main] [provider-provisioning] Environment sync completed {...,"durationMs":501.09}
03:19:55.334 [main] [window-host-remote] renderer attachment ready, sessionId=cb16a52d…, reason=connect
03:19:55.338 [renderer] [DIAG] {"at":"attach.connected","sessionId":"cb16a52d…","reused":false,"current":false}
03:19:55.339 [renderer] [DIAG] {"at":"attach.catch",...,"willCancel":true,"current":false,"error":"Error: project.navigation-cancelled"}
03:19:55.339 [renderer] [DIAG] {"at":"cancelRemoteProject","sessionId":"cb16a52d…"}
03:19:55.340 [zcode-host] window Host topology, reason=remote-session-disposed, connections=0, logicalSessions=0
```

加压运行的第二次复现：两次 connectHost 相隔 510ms，provisioning 耗时 784ms，B 同样报「尚无可用 renderer attachment」，A ready 后同样立即 cancel 并 dispose。

### 3.3 放大窗口后的另一种变体（B 复用了 A 的 session，随后 A 把它销毁）

```
03:14:16.120 [renderer] [DIAG] {"at":"select.bound","sessionId":"f30e0f64…"}                    ← A 已 bind，正在等待
03:14:16.245 [renderer] [DIAG] {"at":"startNewTask","sequence":2}                              ← B
03:14:16.263 [renderer] [DIAG] {"at":"attach.findSession",...,"existing":"f30e0f64…"}            ← B 复用 A 的 session
03:14:17.124 [renderer] [DIAG] {"at":"attach.catch","sessionId":"f30e0f64…","existing":null,"willCancel":true,"error":"…navigation-cancelled"}
03:14:17.126 [zcode-host] window Host topology, reason=remote-session-disposed, connections=0  ← A 销毁了 B 正在用的 session
03:14:17.275 [renderer] [DIAG] {"at":"select.addTab","sessionId":"f30e0f64…"}                    ← B 把 tab 挂到一个已死的 session
03:14:17.331 [renderer] [DIAG] {"at":"attach.catch",...,"error":"Error: project.workspace-identity-mismatch"}
```

基线中也自然出现过一次「A bind 期间 B 到达」。那次 B 的 `findSession` 恰好落在 A unregister 之后，于是 B 重新建连并成功。成功只是因为时序碰巧，代码并不保证这个结果。

## 4. 事件时序图（自然失败形态）

```
Renderer A (seq=1, ProjectCreation.saved)     Renderer B (seq=2, 点击 create-task)     Main desktopRemoteSessions        Host
──────────────────────────────────────────    ────────────────────────────────────    ──────────────────────────        ─────
prepareSession → connectHost
findSession(identity) = ∅
connect(target) ─────────────────────────────────────────────────────────────────────▶ pending(reqA) ─────────────▶ connectSource
                                                                                                                       logical session S
                                                                                       descriptor(S) ◀──────────── remote-connected
                                                                                       route(S) 建立
                                                                                       等 provisioning.initialSync
                                                                                       (140ms～960ms，负载越高越长)
                                              ++navigationSequence   ← A 从此 isCurrent()=false
                                              prepareSession → connectHost
                                              findSession(identity) = ∅（S 尚未 bind）
                                              connect(target) ──────────────────────▶ pending(reqB) ─────────────▶ join 同 target
                                                                                       descriptor(S) ◀──────────── 复用 S
                                                                                       existingRoute(S) 命中
                                                                                       waitForJoinedRouteReady:
                                                                                         无 pendingRendererAttachment
                                                                                         无 rendererAttachmentId
                                              ✖ 立即 reject「尚无可用         ◀────── ✖ 缺陷 2
                                                renderer attachment」
                                                                                       initialSync 完成
                                                                                       attachRendererPort → ready
connect 返回 S ◀──────────────────────────────────────────────────────────────────── resolve(reqA)
assertCurrent() ✖ navigation-cancelled
!existing → cancel(S) ── disposeRemoteSession ───────────────────────────────────────▶ ─────────────────────────────▶ dispose S（connections=0）
                                                                                                                  ✖ 缺陷 1
结果：A 被取消，B 失败，S 被销毁 → 没有远程 tab → waitForRemoteTab 超时
```

## 5. 根因

**一句话**：保存项目后的自动导航和随后的「新建任务」导航并发进入同一个远程项目。Host 让两次 connect join 到同一个 logical session，但 Main 和 Renderer 都把这个共享 session 当作「某一次请求独占」来处理。结果是：后来的 join 在首个 attachment 还没挂上时被直接拒绝（缺陷 2），被取代的导航又按「本次创建」把共享 session dispose 掉（缺陷 1）。

### 5.1 缺陷 1（设计缺陷，需要确认方案）：被取代的导航销毁了共享 session

- `packages/ui/src/project-sidebar/remote-navigation.ts:62-77`：`existing = findSession(identity)`。找不到就 `connect`，`catch` 中执行 `if (!existing) await input.cancel(sessionId)`。注释原意是「只回收本次创建的 attachment」。
- 但「本次创建」不代表「独占」：
  - Host 对同 target 的 connect 会 join 到同一个 logical session。B 的 `connect` 拿到的就是 A 的 S（3.2）。
  - A bind 完成后，S 带着 identity 进入 `useRemoteWorkspaceSessionStore`，B 的 `findSession` 能拿到它（3.3）。
- A 被 `navigationSequence` 取代后走 `handleCancelRemoteProject`（`packages/ui/src/root/useRemoteWorkspaceHistory.ts:1309`）。这会直接调用 `platform.disposeRemoteSession`，Host 侧 `DisposeRemoteWorkspaceSession`（`packages/desktop/src/host/index.ts:3605`）同时拆掉 attachment 和 logical session。
- 「谁在用 S」没有唯一的数据来源：导航请求、Host join、session store 三处各自判断，都没有计数。

### 5.2 缺陷 2（bug）：join 到「首个 attachment 尚未挂上」的 route 时被立即拒绝

- `packages/desktop/src/main/desktopRemoteSessions.ts:572-581`：新 route 建立后先等 `registration.initialSync`（provider provisioning），再调 `attachRendererPort(…, "connect")`。在此之前，route 上既没有 `pendingRendererAttachment`，也没有 `rendererAttachmentId`。
- 同文件 `:554` 的 join 分支调用 `waitForJoinedRouteReady` → `waitForRendererAttachmentReady`（`:399-410`）。这两个字段都为空时直接 reject：「远程 workspace route 尚无可用 renderer attachment」。
- 也就是说，「首次 attach 正在进行」这一状态在 route 上没有记录，join 方看不到它。`mobileOnly` 分支（`:531-547`）和 `:958` 路径用 `providerProvisioningReady` 记录了这个状态，普通 connect 路径（`:562-581`）没有记录。

### 5.3 用例侧：触发了竞态，断言还有缺口

- 用例在保存后再点一次 create-task（`ssh-remote-p0.ts:729`），等于用户的重复操作。这本身合法，但让每个远程用例都去踩这个竞态窗口。
- `waitForRemoteTab` 只检查 tab store 里的 `remoteSessionId` 和 identity，不检查这个 session 是否还活着。3.3 的变体中 tab 挂在已销毁的 session 上，P0 用例仍然 PASS，结束前恰好没有用到远端。

## 6. 相关现象：DSYNC-07+08 同批在 `virtual-project-add` 失败

- **未复现**：7 个同批运行（4×07+08、2×07+08+04、1×高负载 07+08）中，没有一次在 `virtual-project-add` 失败。08 的原始失败工件已经不在。
- **runner 事实**：`harness/remote/remote-wdio-env.mjs:111` 强制 `ZCODE_E2E_MAX_INSTANCES=1`，所以「双 worker」实际是同一批次里**串行**执行的 0-0 和 0-1。两者共享同一个容器和同一个 run 级 `ZCODE_HOME`（`workers.ndjson` 的 capturedAt 前后错开，可以证明是串行）。并不存在两个 Electron 并行抢占的情况。
- **与第 2 条的关系**：`virtual-project-add` 是 `openRemoteProjectSelection` 的第一步（`ssh-remote-p0.ts:289-304`），发生在任何 connectHost 之前。第 2 条的竞态发生在保存项目之后。从阶段上看二者**不是同一根因**。高负载同批运行中确实出现过 DSYNC-07 失败，但报错是第 2 条的「remote tab … 没有收敛」，不是 `virtual-project-add`。
- **推测（未验证）**：当时多个 worktree 的 runner 同时运行，负载很高，侧栏的 `virtual-project-add` 没能在 10s 的 `waitForClickable` 内可点。建议再遇到时保留 `failures/<cid>/…/video.webm` 和 desktop 日志再判断。修复第 2 条之后，同批失败中属于第 2 条的那部分会消失。

## 7. 建议修法（找唯一数据源，不靠超时或重试）

1. **Main：让「首个 attachment 正在挂载」成为 route 上的唯一事实**（修缺陷 2，属于 bug 修复）
   - route 创建时把 `registration.initialSync.then(() => attachRendererPort(win, route, "connect"))` 作为 `route.initialAttachment`（或复用已有的 `providerProvisioningReady` 字段）。
   - `waitForRendererAttachmentReady` 的判断顺序改为：pending → 已有 attachment → `initialAttachment`。只有三者都不存在时才 reject。
   - join 方等待的就是首连本身的 promise，首连失败时 join 方也一起失败。不新增定时器。
   - 文件：`packages/desktop/src/main/desktopRemoteSessions.ts`（`handleDescriptor` 约 :514-610，`waitForRendererAttachmentReady` :399，`waitForJoinedRouteReady` :420）。

2. **共享 session 的归属：由一个 owner 维护占用计数，导航取消只释放自己那一份**（修缺陷 1，属于设计缺陷，需要先确认方案）
   - 现状：Host join 和 renderer `findSession` 都会让多个导航共用 S，但 dispose 的判断依据是单次请求的 `existing`。
   - 建议的唯一数据源二选一：
     - a. Main route 维护 claim 计数：每次 connect（新建或 join）+1，renderer 因导航取消发出的释放 −1，归零且没有被 bind 的 tab 时才向 Host 发 `DisposeRemoteWorkspaceSession`。
     - b. Renderer 的 `useRemoteWorkspaceSessionStore` 维护 lease：`findSession` 和 `connect` 返回时 acquire，`attachRemoteProjectWorkspace` 的 catch 改为 release；`handleCancelRemoteProject` 只在 lease 为 0 且没有 tab 引用时 dispose。
   - 我倾向 a：join 发生在 Main/Host，renderer 看不到 Host join，只有 Main 能同时看到「新建」和「join」两种来源。
   - 文件：`packages/desktop/src/main/desktopRemoteSessions.ts`、`packages/ui/src/project-sidebar/remote-navigation.ts`、`packages/ui/src/root/useRemoteWorkspaceHistory.ts`（`handleCancelRemoteProject`），可能还有 `packages/ui/src/Root.tsx:771`（`openPreparedRemoteProjectWorkspace`）。
   - 可选的减量：同一 `{hostId, projectId}` 的新建任务请求如果已有一个在进行，新请求复用它（single-flight），不再递增 `navigationSequence`（`useRootWorkspaceActions.ts:212`）。这只能消除「保存后再点一次」这一触发场景，不能替代第 2 点：快速切换同设备的不同项目仍会共用 Host session。

3. **测试**（先写测试再修）
   - 单测：`desktopRemoteSessions` 中「首连 provisioning 未完成时 join」应等待首连 ready，而不是立即 reject；导航取消释放 claim 后，仍被 join 的 session 不被 dispose。
   - E2E：新增一个用例，保存远程项目后在首连期间立即点 create-task，要求远程 tab 收敛且 session 存活。并把 `waitForRemoteTab` 加强为同时检查 `useRemoteWorkspaceSessionStore` 中有这个 session（或 Host topology 中 logicalSessions ≥ 1），避免挂在已死 session 上的 tab 被判为通过。
   - 修复之后，`selectSSHRemoteDirectory` 的第二次点击可以保留，它正好覆盖用户的重复操作。
