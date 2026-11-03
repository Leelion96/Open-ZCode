# 多 Session 光标 Overlay 与视觉升级 Spec

状态：已实施（2026-10-24，落地事实与偏差见 §12 实施记录；Windows 真机验收待做）
范围：`packages/zcode-cua`（macOS + Windows 双平台的 ghost cursor 多实例化 +
运动曲线 + 朝向 + 多颜色）
关联分支：`feat/cua-multi-color-cursor`

## 1. 背景与目标

当前 ghost cursor 是 **macOS 进程级单例**：全局一个箭头（`ghost_cursor.mm` 的
`g_dot/g_bloom`）、瞬移（`CATransaction setDisableActions:YES`）、固定蓝色
（`GhostBlueColor`）。多个 agent session 并发使用 CUA 时，屏幕上只有一个光标在
跳，用户无法分辨「哪个会话在动」。Windows 侧连光标都没有——用户可见反馈只有
desktop 的 Electron 指示条（`windowsCuaOperationIndicator.ts`，单一文案卡片，
无 per-session 区分、无位置可视化）。

目标：

1. **多 session 多 agent**：每个 CUA session 一个独立光标实例，共用一个 overlay
   窗口合成；显示/隐藏/位置/颜色互不干扰。
2. **多颜色**：光标颜色由 session id 稳定派生（11 色板，产品色卡），并发会话一眼可区分。
3. **曲线运动**：点到点滑行走三次贝塞尔 + 速度包络 + 到达弹簧回弹，替代瞬移。
4. **方向变化**：滑行中箭头朝向随路径切向旋转，到达后回正到基准角。
5. **Windows 同步落地**：Windows native overlay 一次到位（多实例 + 颜色 +
   曲线），复用与 macOS 共享的纯 C++ 运动学核心。
6. **文字 tip（badge）**：光标旁药丸显示 node_repl 代码块的 `title`（每
   cell 一个，模型经 SDK 调 CUA 时契约必填、进程内流转，§4.8），
   **与光标共用组生命周期**（组在文字在，组隐藏文字即消失），双平台。
7. **多屏正确**：多光标可分居多屏同时可见（macOS 每屏一窗，§4.10），
   负坐标副屏、混合 DPI、热插拔均有明确方案。
8. **Gate 默认开**：kill-switch 式开关（§4.9），预留用户
   设置接口（本期不暴露）。

非目标（见 §9）：多 controller 并发输入、完整主题生态、Linux overlay、
MCP 光标工具面。

## 2. 实施边界

产品行为、状态归属与平台契约由下文规定；本规格不保留外部实现的目录、算法对照表或版本调查材料。

## 3. 本仓现状与差距

| 能力 | 现状 | 差距 |
| --- | --- | --- |
| 多 session 事件 | 已有且**平台无关**：宿主 `cuaOperationTurnTracker`（`packages/services/src/zcode-agent/`）→ `pip_session_event`（协议 v2，`turn-started/turn-ended/session-closed/focus-changed`，带 `sessionId/turnId`，幂等去重、sequence 仲裁）→ Helper `pip-session/coordinator.ts` 多 session 状态机。Windows 端到端可用（coordinator 不门控平台，只有 native PiP 消费端是 mac-only） | 事件通道可直接复用；但 turn lifecycle 对光标只有 `anyTurnRunning()` 一个布尔（`broker/server/ghostCursorTurnLifecycle.ts`，Windows 上因 native 方法不存在而是 no-op） |
| macOS 光标 | `src/native/ghost_cursor.mm`（1347 行）：进程级全局单例 `g_window/g_dot/g_bloom`，NAPI 面 `ghostInit/Show/Move/ClickRipple/Hide/State/...` 全部无 session 参数 | 需多实例化 + session 路由 |
| Windows 光标 | **无**。native 侧无任何可见窗口能力（`ax_win.cc` 唯一 `CreateWindowExW` 是剪贴板隐藏消息窗口）；ghost\* 13 个 NAPI 导出与 pip\* 系列全缺；用户反馈只有 desktop Electron 指示条（`packages/desktop/src/main/windowsCuaOperationIndicator.ts`，多 turn 聚合计数但无 per-session 光标） | 需新建 `ghost_cursor_win.cc` 全套 |
| 视觉 | 箭头 + 热点环 + 点击涟漪 + keyPulse + focus-rect + 180ms idle 淡出 + 20s 活动租约；`MoveGhostTo` 瞬移；`GhostBlueColor` 硬编码 | 加曲线/朝向/多色 |
| 遮挡抑制（macOS） | 已有：overlay 在 `NSScreenSaverWindowLevel` 且可见时 `orderFrontRegardless`（恒在用户窗口之上）+ **光标点位 owner-walk 探测**兜底（租约活跃且有 target 时每 100ms 一次）：确定性遮挡（owner ≠ target）→ 立即 alpha=0 + 丢弃 pending 涟漪；不确定态（探测无结果/竞态）→ 连续 3 次（300ms 宽限）才降 alpha 且不吞涟漪；确认可见 → 恢复 + 补播涟漪（`ghost_cursor.mm` 统一可见性模型：`alpha = idle_alpha × occlusion_alpha`） | per-group 化 + 整窗 opacity 下沉为组 opacity（§4.4） |
| 会话结束隐藏 | 已有（`docs/cua/producer/ghost-cursor-turn-end-hide.md`）：`turn-ended/session-closed` → `withGhostCursorTurnEndHide`（仅当无其他 running session 才 `ghostHide`）→ **立即**隐藏（清 target、停探测、orderOut），非淡出；`turn-started` 刻意不主动显示（无动作显示光标无意义）；20s 租约 + 180ms 淡出仅是轮内兜底，不缩短 | per-session 化后 `anyTurnRunning` 守卫自然消解（§4.7） |
| 工具调用标题（badge 数据源） | **生产链路是 SDK 而非 MCP 工具**（`docs/cua/2026-08-24-cua-node-repl-sdk-migration-spec.md`）：模型只调 `node_repl` 的 `js`，cell 内 bootstrap CUA SDK 经 bridge `{method, input, context}` 进 `ComputerUseRuntime.execute`。`js` 契约**必填 `title`**（用户语言简短标题，`apps/zcode-cli/packages/contracts/src/tools/node-repl.ts:24`），host 已把它放进 `callMeta`（`node-repl-host/src/server.ts:217`）→ `executeJs({requestMeta})` → bridge context 由 requestMeta 构造（`cua-bridge.ts:66`）——**title 已在进程内链路上流转，一个代码块一个 title** | context 透传到 `ComputerUseRuntimeContext` → broker 消息（§4.8），零协议新增 |
| 多显示器（macOS） | 已修过两个根因（`docs/cua/producer/ghost-cursor-multi-display-spaces.md`）：①并集窗口在默认 Spaces 下只上「面积最大的屏」→ 改为**单窗跟随反馈点所在屏**；②CG→NS 坐标翻转基准误用 `mainScreen`（key window 的屏）→ 一律 `PrimaryScreenFrame()`。已知代价：跨屏 glide 边界跳变 | **单窗跟随在多光标下失效**（两 session 分居两屏时窗口只能跟一个）→ macOS 改每屏一窗（§4.10） |
| Gate/开关 | ghost overlay 走 argv `--ghost-cursor-overlay`（产品链两处硬编码 true，无设置项）；kill-switch 先例 `--disable-cps-activation`（默认开，argv=关）+ env 翻译函数 `cpsActivationDisableRequested`；argv 唯一构造点 `buildHelperOpenArgs` + `HelperLaunchSpec`（五次漏传教训注释）；旧 Helper 白名单式解析、未知 argv 安全忽略 | 新 gate 照 kill-switch 范式（§4.9），默认开 |
| session 身份到 fire 点 | **比早期认知好得多（已核实）**：SDK 主链路的产品 sessionId（裸 `sess_*`）每请求流入 Helper——`trace.sessionId → request-context.session_id → context.sessionId`（cua-bridge 必填校验），`capture_app` 已带 `pip_session_context.session_id`；普通动作带复合 `session_key`（input-hold 域）。缺的只是：ghost fire 点（`ax_macos.mm:71-76`）与 Windows fire 点（`ax_win.cc` 经 `windowsInputDispatch.ts`）无 session 参数、native API 单例 | fire 点/seam 消费既有 `context.sessionId`（P0 最后一公里），光标 key 统一用裸 sessionId（§4.1） |
| Windows 输入并行 | S4 并行实验 P6「同 Helper 双 MCP session 并行元素点击」已 pass（`2026-10-19-windows-input-s4-parallel-baseline.md`） | 多 agent 输入并行有实证，光标可视化跟得上语义 |
| 单写者约束 | `ControllerLease` 全局唯一 controller（文件锁，Windows 分支就绪：`controllerLease.ts:122`） | 保持不变：多光标仅展示层，输入仍单写者 |
| 测试基建 | `test/matrix/` 三层门控（平台不匹配 skip → `ZCODE_CUA_HARNESS_E2E=1` opt-in → fixture 缺失 fail-fast）；`scripts/windows-harness-parallel-experiments.mjs` 双 MCP session runner | 直接复用为 Windows 多光标真机验收 |

其他 Windows 事实（实施时注意）：

- **binding.gyp 有两份**：根目录 `packages/zcode-cua/binding.gyp` 是权威
  （Windows 编 4 个源文件），`src/native/binding.gyp` 是旧拷贝（缺 2 个源）——
  新增 Windows 源只改根目录那份。
- Helper 传输 Windows 走 named pipe（`src/broker/socketPath.ts`，
  `\\.\pipe\zcode-cua-helper-` 前缀），协议与 unix socket 同构。
- Helper peer 身份门在 Windows 有暂态（`helperMain.ts:1054-1070`，
  `WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN`）——overlay 是用户可见反馈面，
  其安全语义随这道门一起收口，本 spec 不单独引入新门。
- argv `--ghost-cursor-overlay/--ghost-cursor-capture` 原先只在 macOS launcher
  拼接（`helperLauncher.ts:362`）。**2026-10-26 Windows 链路已对齐（恒开语义）**：
  两条 Windows 启动链（懒启动 `computer-use-runtime.ts` 的
  `ensureWindowsHelperForked`、产品链 `windowsCuaDevHelperHost.ts` 的
  `startGeneration`）argv 均追加 `--ghost-cursor-overlay`；
  `parseWindowsDevHelperConfig` 放宽为「必含 `--socket/--parent-pid` 的
  白名单集合」，未知 argv 安全忽略（与旧 Helper 口径一致）；
  `runWindowsDevHelper` 在 native 注入后 `ghostSetEnabled(true)` +
  `ghostSetMultiCursorEnabled(!disableMultiCursorOverlay)`——Windows dev
  helper 组合根不经过 `helperMain.main()`，启用接线必须落在组合根内。
- 指示条的前车之鉴：Windows 上 `BrowserWindow` hide 后 `WS_EX_TOPMOST` 会被
  清除，每次显示必须重设置顶（`windowsCuaOperationIndicator.ts:190-196`）——
  native overlay 的 z 序策略必须自带周期性重钉，不能一次设置。

## 4. 总体设计

### 4.1 身份模型：产品 sessionId 即光标 key（平台无关）

唯一真相源 = 宿主 turn tracker 的 **产品 sessionId**（`sess_` + UUID，单一
真值源 `createSessionId()`）。光标 key、颜色派生、显示生命周期全部用它，与
turn 事件天然同源，不引入第二套身份。

**关键调研结论（已核实，修正早期认知）**：SDK 主链路（生产链，node_repl）
的产品 sessionId **现在就已 per-request 流到 Helper**，不存在「缺一整条
路由」——`trace.sessionId → MCP request-context（com.zcode/request-context
.session_id，cua-bridge 构造 context 时必填缺失抛错）→ runtime.execute
({context})`；`capture_app` 已带 `pip_session_context.session_id`（同为裸
产品 sessionId）。真正缺的只有最后一公里：**ghost fire 点与 native API 不
消费它**。

```text
SDK 主链路（生产链；★ = 本次新增的最后一公里）：
CLI trace.sessionId（sess_*）
  → MCP _meta request-context.session_id（每 tools/call）
  → node_repl host cua-bridge：context.sessionId（必填）
  → runtime.execute({context}) → callBroker 全动作注入 pip_session_context ★
  → Helper brokerServer：分派前建请求级 ALS scope ★
  → nativeAxSource addon Proxy：指针类调用窗口内设 ghost request scope ★
    （键盘异步 worker：入队时拷贝 sid，OnOK 显式传）
  → ghost_cursor.mm / ghost_cursor_win.cc：per-session 光标实例
```

key 取值规则（P0 固化）：

- **光标 key = 裸产品 sessionId（`sess_*`）**——与 `pip_session_event`
  的 sessionId、`pip_session_context.session_id` 同 key（turn-end 隐藏才对
  得上组）。**不是** `sessionKeyFor` 的复合键（`workspace\0remote\0session`，
  那是 input-hold 域的 key），也**不是** `ToolDeps.sessionKey`（SDK 链不经过
  `buildServer`，该字段属于独立 MCP server 入口）。
- Helper 是跨会话单例（node_repl runtime 一进程多 session、Helper broker
  跨进程单例），**身份只能 per-request 传**（现状 `pip_session_context` /
  `session_key` 均如此）——不做构造期注入。
- 独立 stdio/HTTP 入口（standalone，非本期必须）：`BuildServerOptions.
  sessionKey` 的消费者——stdio 一进程一会话构造期注入安全（`index.ts
  main()`）；streamable-http 建 session 时从 initialize `_meta` 取
  `session_id`，缺失回落 `randomUUID()`（`http-server.ts:295` 现状）。
- 未注入（standalone / demo / 旧宿主）：退化为现状（macOS 单光标默认蓝；
  Windows 无 overlay），行为完全向后兼容。
- badge 文字来源见 §4.8（node_repl cell title，SDK 链路）；MCP 直调无
  badge（已定，不做 displayName 兜底）。

### 4.2 macOS 渲染架构：每屏一窗、per-session layer group

macOS overlay 从「单窗跟随反馈点所在屏」改为**每屏一窗**（多光标多屏的硬
要求，见 §4.10），每窗内部从单组全局 layer 改为 map：

```text
每块屏一个 ghost overlay window（click-through、跳过镜像屏，§4.10）
└─ contentLayer（contentsScale = 该屏 backingScaleFactor）
   ├─ session layer group "session-a"     ← 懒创建：该 session 首个动作时诞生
   │    ├─ arrowLayer   (tint=session 色, transform.rotation = heading)
   │    ├─ bloomLayer   (热点环, 同色)
   │    ├─ rippleLayer  (点击涟漪, 同色)
   │    ├─ badgeLayer   (文字 tip，§4.8)
   │    └─ focusRectLayer
   ├─ session layer group "session-b"
   │    └─ ...
   └─ (插入序 = z 序；last_active 组在最上；不在本屏的光标组不参与绘制)
```

每个 session 的渲染状态遵循：

- **懒创建**：首条 move/ripple 命令才建组；新组首个动作从目标左上 `SEED_OFFSET`
  （140pt，clamp 进屏、角落翻转到右下）滑入。
- **墓碑**：`session-closed` → 移除组并记 tombstone；迟到命令丢弃，不复活。
- **default 守卫**：key 为空或 `"default"` 时走现状全局单光标路径。
- **全局态广播**：`ghostSetEnabled / ghostSetCapture / ghostSetControllerStatus`
  作用于全部组（enable 开关、capture 排除、controller 状态本来就是进程级语义）。
- **per-session 态**：位置、可见性（20s 租约 + 180ms idle 淡出）、目标绑定
  （pid/windowId 投递归属探测）、遮挡去抖、focus-rect 全部按组隔离（遮挡模型
  见 §4.4，生命周期见 §4.7）——这是现有单例语义的逐项拆分，回归面见 §10。

### 4.3 Windows 渲染架构：layered window + 软件光栅

新建 `src/native/ghost_cursor_win.cc`，与 macOS 共享 session 路由与运动学核心，
渲染管线如下：

- **窗口**：`RegisterClassExW` + `CreateWindowExW`，样式
  `WS_POPUP | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`，
  铺满虚拟屏（`GetSystemMetrics(SM_X/CXVIRTUALSCREEN)` 族，与 SendInput 输入链
  同一坐标系语言）；`ShowWindow(SW_SHOWNOACTIVATE)`。`WS_EX_TRANSPARENT` 保证
  点击穿透（窗口根本收不到鼠标消息）。
- **渲染**：软件光栅到 32bpp top-down **premultiplied BGRA** DIB section
  （箭头多边形 + 多层宽描边柔光/涟漪圆环是简单光栅原语，自绘足够，不引 D2D 依赖）→
  `UpdateLayeredWindowIndirect(ULW_ALPHA, AC_SRC_OVER + AC_SRC_ALPHA, prcDirty)`。
  **持久表面 + 脏矩形**：每光标包络矩形（含将来的 badge 宽度余量）取并集，
  只 clear/重绘/上传脏区，避免每帧重建全屏表面。
- **边界与清除（2026-10-26 回归约束）**：绘制包络可以越过虚拟屏边缘，
  但清除和上传前必须与实际 DIB 表面求交；`prcDirty` 不得带负坐标或超出表面。
  Windows 实测：负的 left/top 会使 `UpdateLayeredWindowIndirect` 返回错误 87。
  上一帧包络只记录**成功上传**的像素范围，由窗口线程唯一维护；标题宽度、
  DPI 或位置变化不另行推算旧 badge 的位置。每帧清除并上传「上次成功包络 ∪
  当前包络」。当前组因遮挡变透明时，即使运动仍在继续，也必须清除上次包络。
  回归覆盖四边/角落、运动途中越界、负虚拟屏原点、标题替换、多 session
  隐藏/移除、上传失败后的下一帧恢复；使用隐藏 HWND 调真实 Windows 上传 API，
  比较实际上传的像素与从透明表面完整绘制的结果。
- **线程与节奏**：窗口线程跑标准消息循环（窗口必须建在同一线程）；`WM_TIMER`
  三档节奏——ACTIVE 8ms（动画期持 `timeBeginPeriod(1)`，作用域进出成对，防
  全局分辨率泄漏）/ HOVER 80ms / IDLE 250ms（释放表面与 1ms 分辨率，DWM 保留
  自己的 layered 拷贝画面不变）；命令跨线程经 mpsc 投递，IDLE 唤醒用跨线程
  `SetTimer(hwnd, 8ms)`；`dt = clamp(real_dt, 0, 50ms)` 防默认 15ms 分辨率半速。
  NAPI 调用来自 Node 主线程，命令只做投递不做渲染，不阻塞事件循环。
- **z 序**：不做 per-target pin（遮挡由 §4.4 的点位探测模型保证，不依赖 z 槽），
  采用「普通带最前」策略并周期性重钉（80ms 级）：`HWND_NOTOPMOST` 归一 → 无锁
  落顶（TOPMOST→NOTOPMOST 两连非激活，避开前台锁）。指示条的「hide 后
  topmost 丢失」坑由周期重钉天然覆盖。
- **capture 排除**：对齐 macOS ghost 的 capture 开关语义；截图窗口期
  `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` + 两次 `DwmFlush()`
  + RAII 恢复（Win10 2004+；老系统上报 `not_excluded` 继续跑）。本仓 Windows
  截屏走 WGC（`screen_capture_win.cc`），WGC 遵守 display affinity。
- **DPI**：进程为 Per-Monitor-V2、坐标全物理像素（与
  `ReadWindowFrameBounds`/WGC 位图 1:1 对齐的现有约定）；光标/badge 绘制按
  **光标热点所在屏的 scale**（display_geometry 提供）——union 单窗即可一次
  解决混合 DPI（§4.10.6：表面为物理像素、逐像素自绘，无 DWM 缩放）。
- **多屏变化**：表面几何按虚拟屏指标分配，`(virt_x, virt_y, w, h)` 不匹配时
  自动重建；WM_DISPLAYCHANGE 后重读指标。

### 4.4 遮挡与可见性模型（双平台）：光标不出现在用户正在操作的窗口上

现有遮挡规则：

- **本仓现状（macOS 单光标）**：overlay 在 ScreenSaver 层恒置顶（可见时
  `orderFrontRegardless`，不抢焦点）+ **光标点位 owner-walk 遮挡探测**兜底
  （`ghost_cursor.mm` 统一可见性模型）。探测规则：
  - 租约活跃且有 target 时每 100ms 一次，对光标坐标做交互窗口归属探测
    （排除 overlay 自身）；Auto 模式首次探测采纳 owner 为 target。
  - **确定性遮挡**（owner 明确命中外部可交互窗口且 ≠ target）：立即
    alpha=0，并丢弃 pending 涟漪（用户看不到的光标播涟漪，等于宣告 agent
    在别人的窗口上操作）。
  - **不确定态**（探测无结果/窗口动画竞态）：连续 3 次（300ms 宽限）才降
    alpha，且不吞 pending 涟漪——旧行为「单次 miss 即隐藏」把瞬时竞态当
    遮挡，是修过的 bug。
  - **确认可见**：恢复 alpha=1 + 补播 pending 涟漪。

**决策：保留本仓探测模型，per-session 化**：

1. 点位探测以光标坐标做判定：多光标各自探测各自的遮挡，与 overlay 窗口 z 槽无关，
   「用户窗口夹在两个被驱动窗口之间」的场景下每个光标仍能正确隐藏。
2. 现有单光标行为已按此语义打磨（立即隐藏/300ms 去抖/涟漪丢弃都是修过的
   bug），沿用即免重趟；z 序策略也因此保持简单（macOS 维持 ScreenSaver 层
   + orderFrontRegardless；Windows 普通带最前周期重钉，§4.3）。

per-session 拆分要点：

- alpha 三分量模型照搬每组：`group_alpha = idle_alpha × occlusion_alpha`，
  可见判据 >0.004（沿现状）。
- **遮挡探测按组独立**：每组的 target（Auto 首探采纳 / Pid 绑定）、probe
  generation、不确定计数独立；一组被遮挡不影响其他组。
- **共享快照**：每个探测 tick 只做**一次**窗口列表快照（macOS
  CGWindowList / Windows 窗口枚举），供全部组判定——避免 N 组 × N 次枚举。
- **重构点**：现行 `ApplyFeedbackAlpha` 把 alpha 写在整窗
  `g_content.layer.opacity`——多组后必须下沉为 per-group layer opacity，
  否则一组淡出/被遮挡会带动全部组。
- 涟漪丢弃语义保留（确定性遮挡才丢；不确定态保留待确认）。
- **Windows（P3）**：`WindowFromPoint`（排除自身 HWND，`GetAncestor(GA_ROOT)`
  归一）做等价 owner-walk，同一「确定性立即 / 不确定 300ms 去抖」模型；
  探测挂在窗口线程 HOVER 档（80ms）里，不必另起节拍。

### 4.5 多颜色：session 稳定派生，11 色板产品色卡（双平台同一实现）

颜色采用本产品色卡（12 色中剔除 Coconut Milk——近米白填充在浅背景上不可辨）；
**派生逻辑写成纯 C++ 共享函数**（mac/win 同一份源码编译）：

```text
SESSION_FILLS（11 色板 = 产品色卡，插入序即索引；顺序为色卡从左到右、从上到下）:
   0 Pineapple Soda    #FFE485       6 Blue Lagoon       #AFDFEE
   1 Berry Pop         #F698DB       7 Peach Smoothie    #FFBDB4
   2 Palm Leaf         #E1EEAF       8 Raspberry Sorbet  #F72967
   3 Cherry Blossom    #FFD3E4       9 Splish Splash     #46C6D7
   4 Pool Day          #92D1FF      10 Fresh Lavender    #BCACDD
   5 Lemonade Stand    #FFD058
默认（"default"/空 key）: #1F8CFF（现状 GhostBlueColor 0.12/0.55/1.0，
                        保单 session 观感与现状无差异）

index(sessionId):
  尾缀数字 n（按 - _ . 分割取最后一段纯数字）→ (n-1) mod 11
  单字母                → 字母序 mod 11
  其他                  → FNV-1a 风格 hash mod 11
```

- 箭头填充、涟漪、focus-rect 同色；badge 文字白色。**描边策略
  （2026-10-25 随换装更新）：箭头主体描边恒白**，在深浅和同色背景上保持边界可辨；**每色加深一档的
  同色系颜色**（按填充色 HSL 降亮度固定比例派生，L×0.55）保留给 badge
  描边、涟漪、focus-rect——同一规则适配深浅所有填充，不引入外来色；
  纯函数与色板同文件，随颜色派生单测覆盖全部 11 色 + 默认蓝。
- 美术顶点（箭头路径）放共享头，两平台各自光栅，保证观感一致。

**箭头美术（2026-10-25 换装，替换旧 22×28 三角）**：使用随 producer 维护的矢量资产，128 单位画布缩放至 **42pt 显示足印**，hotspot (55,30) 即 tip：

- 路径：8 顶点闭合曲线（每顶点带 in/out 切向控制点，三次贝塞尔分段），
  现代箭头轮廓（非等腰三角）；
- 分层：8 层同色柔光描边（宽 44→7 画布单位递减、不透明度 2%→9.5% 递增，
  session 色）+ 白描边 5 单位 + session 色填充；default 组同款处理
  （填充即 #1F8CFF），仅颜色随 key 派生；
- 数据放 `motion_math.h`（`kCursorArtPath` / `kCursorGlowStrokes` /
  `FlattenCursorArtPt`）：macOS 直接建 CGPath 多层 `CAShapeLayer`，
  Windows 展平折线软件光栅；
- 旧热点环（14pt bloom 圆环）删除——柔光已内建，叠加冲突；
- 渲染锚定语义不变：tip = anchorPoint，朝向旋转绕 tip。
- **不暴露颜色参数**（argv/env/broker/MCP 均不传色）：颜色只能由 sessionId 派生，
  避免配置面与主题系统膨胀。

### 4.6 曲线运动与朝向：纯 C++ 共享核心

运动学核心（贝塞尔、速度包络、spring、朝向）写成**平台无关纯 C++**
（`motion_math.h/.cc`，无 ObjC/Win32 依赖，mac/win 各自的渲染层只消费其输出
的每帧 `(x, y, heading)`），参数如下：

| 参数 | 默认 | clamp | 说明 |
| --- | --- | --- | --- |
| `start_handle / end_handle` | 0.3 / 0.3 | [0,1] | 贝塞尔控制点沿连线分布比例 |
| `arc_size` | 0.25 | [0,1] | 弧偏移幅度（连线长度比例） |
| `arc_flow` | 0.0 | [-1,1] | 弧顶偏向（正→靠近终点） |
| `spring` | 0.72 | [0.3,1.0] | 到达回弹阻尼（1=临界） |
| `peak/min_start/min_end_speed` | 900/300/200 pt/s | — | 速度包络 `16u²(1-u)²` |
| `max_glide_s` | 0.8s | — | 单段滑行时长上限（不含 spring 回弹）；超出时整条路径按比例提速 |
| `dwell_after_click` | 80ms | — | 点击后驻留（沿用现有涟漪节奏） |
| `SEED_OFFSET` | 140pt | — | 新光标入场偏移 |

行为规则：

- **落点 = 点击点（2026-10-25 根因修正）**：早期保留了
  `CLICK_OFFSET=16pt`，但本仓渲染是 **tip 锚定**（hotspot 即 anchor），
  保留该偏移导致 tip 落在点击点左上 ~11.3pt、与涟漪圆心（真实点击点）
  错位 16pt。tip 锚定下偏移恒为 0：tip 精确压点击点，涟漪与 tip 同心。

- **滑行时长上限 0.8s（2026-10-27）**：按原速度包络走完一段路径的耗时
  `natural = 弧长 × ∫₀¹ du / v(u)`（默认参数下约 0.00204 s/pt，≈ 390pt 弧长即 0.8s）。
  `MoveTo` 时算 `time_scale = max(1, natural / max_glide_s)`，`Tick` 前进
  `v(u) × time_scale × dt`。短距离（natural ≤ 0.8s）行为完全不变；长距离保持
  包络形状、整体提速，恰好 0.8s 走完。spring 初速按**未缩放**的末端速度取，
  避免长距离到达时回弹冲过头。动机：原包络下用时与距离成正比，双屏跨屏
  （~2500pt）约 5s、4000pt 约 8.7s，光标明显落后于实际输入。
- **新命令顶替**：进行中的滑行被新 move 直接打断，从当前位置重新规划贝塞尔。
  连续动作流（settler 节拍）下表现为持续顺滑追赶，不排队。
- **输入不等动画**：动画纯表现层；输入投递时序完全不变（settler、
  InputHold、KillSwitch 语义不动；Windows 的 sent/possibly_sent 终止语义、
  物理 lane 串行不动）。
- **朝向**：滑行中每 tick `heading = 路径切向`（直接赋值）；到达设为基准角
  （现箭头美术的左上朝向，即 45°）；渲染绕热点 `rotate(heading - 基准角)`。
- **spring settle**：路径走完转弹簧（`k=spring*400, c=spring*20`，半隐式欧拉
  4 子步），位移 <0.3pt 且速度 <2pt/s 时钉住。
- **reduced motion**：macOS 跟随
  `NSWorkspace.accessibilityDisplayShouldReduceMotion`；Windows 跟随
  `SystemParametersInfo(SPI_GETCLIENTAREAANIMATION)`（P4）；开启时跳过曲线
  直接落位、无回弹。
- macOS 侧动画驱动复用 ghost 现有 tick 通道扩展为 per-group 状态机；Windows
  侧由 §4.3 的 `WM_TIMER` ACTIVE 档驱动。两侧都禁用隐式插值（macOS 保持
  `CATransaction setDisableActions:YES`；Windows 本来就是显式光栅）。

### 4.7 显示生命周期（per-session 化，与现行 turn-end 隐藏语义对齐）

现行机制（`docs/cua/producer/ghost-cursor-turn-end-hide.md`，全部保留语义）：
turn 结束**立即**隐藏（非淡出）、`turn-started` 不主动显示（无动作显示光标
无意义）、20s 租约 + 180ms 淡出只是轮内兜底不缩短。per-session 化后
`anyTurnRunning()` 布尔守卫自然消解——每组只被自己的 turn 事件隐藏，不存在
「A 结束藏掉 B」：

```text
turn-started(sessionId)   → 仅标记 pending（不显示，对齐现行决策）
move/ripple/…(sessionId)  → 该组显示（懒建组 + SEED 入场）+ 刷新 20s 活动
                            租约；遮挡探测随组启动（§4.4）
turn-ended(sessionId)     → 该组立即隐藏（对齐现行 ghostHide 语义：清该组
                            target、停该组探测、alpha=0，无淡出）；组保留，
                            下一轮首个动作经正常反馈路径恢复
session-closed(sessionId) → 移除组 + 墓碑
20s 租约到期             → 180ms idle 淡出（事件缺失时的兜底，语义不变）
全部组隐藏               → overlay 窗口 orderOut + 停 pump（对齐现状唯一的
                            orderOut 路径；controller release 同为进程级：
                            隐藏全部组 + orderOut）
```

### 4.8 Badge（文字 tip）：显示当前工具调用标题

badge 文字取
**node_repl 代码块的 `title`**——生产链路上模型经 SDK 调 CUA（一个 cell 一个
title，`js` 契约必填、模型已在写），title 全程进程内流转，零协议新增：

```text
模型调 node_repl js({title: "点击搜索按钮", code: "…agent.computerUse…"})
  ▼ js 契约必填 title（既有契约，非本 spec 新增）
node_repl host：callMeta = {…requestMeta, title}（server.ts:217）
  ▼ executeJs({requestMeta}) → Worker 内 SDK 调用
cua-bridge：context 由 requestMeta 构造（cua-bridge.ts:66 注入点，
  确保 title 进 context——现状 requestContext 可能未保留，需核对）
  ▼ bridge {method, input, context}
ComputerUseRuntime.execute：requestMeta 回传 title（snake: title）→
  callBroker 注入 pip_session_context.action_title（§5 同一条消息）
Helper native：addon Proxy 在指针类调用边界推
  ghostBeginActionWithTitle → ghost_cursor_update_badge(sid, title)
  ▼
渲染：per-group badge 层（药丸：title 文字 + session 色底），挂组容器
  共享组 opacity（组隐藏文字即消失，无独立状态机）
```

语义天然是「**一个代码块一个 title**」：cell 内所有 CUA 动作共享同一 title，
换 cell 才换文字；同 cell 连续动作不重闪，换 cell 自然换字。非 node_repl
调用方
（standalone MCP / 14 工具面直调）无 title → 无 badge，天然满足「不动工具
参数」约束。协议流的 `state.title`（工具名）不采用。国际化随 js 契约解决：
模型按用户语言写标题。

设计要点：

- **title 通道（进程内，零协议新增）**：title 来自 `js` 契约必填字段（既有，
  非本 spec 新增），经 `callMeta` → bridge context →
  `ComputerUseRuntimeContext` 增挂 `actionTitle` 字段随 execute 下发。核对点：
  `requestContext()`（`cua-bridge.ts`）构造 context 时保留 title。MCP 14 工具
  面参数不动；直调工具面（standalone/测试）无 title 无 badge。

- **时序 = 组生命周期，badge 不自治计时**：badge 与光标共用 §4.4/§4.7 的组可见性——组显示则文字显示，
  组淡出（idle 180ms 淡出随光标一起）、组被遮挡、turn-end 立即隐藏、
  session-closed 移除，badge 全部随之，**不出现「光标没了文字还在」或反之**。
  cell 活跃期间文字常显，用户中途查看时仍能识别当前动作。
  文字更新即换字（同 cell 连续动作同 title 无变化，无闪烁问题；无需
  「文本变化才重置」状态机）。**硬件指针悬停恢复**仍保留——仅作用于
  已淡出组的短暂回看（badge rect 命中），悬停采样搭 §4.4 遮挡探测的车
  （探测 tick 已在拿硬件指针位置，macOS HIDSystemState / Windows
  GetCursorPos，零新增轮询）。
- **位置**：badge 中心对齐光标 x、位于 tip 下方 `kBadgeOffsetY=45pt`
  （2026-10-25：42pt 新美术身体最低点在 tip 下 ~30pt（含 glow），旧值
  25pt 会盖住箭头下半截；45 = 30 + 药丸半高 ~12 + 余量），跟随移动 +
  屏幕边缘 clamp；**不随光标朝向旋转**（文字必须正立）。
- **净化与截断**（两级）：native 侧 `sanitize`（去控制字符、
  折叠空白）+ 28 字符预算，**超预算截断时末尾补 `…`**（结果 = 27 字符 +
  `…`，总长仍 ≤28）；渲染侧按
  **像素宽**省略号截断（badge 最大宽 188pt，标题超长如「打开 Maps 并
  搜索咖啡馆」按像素收敛到 `…`）。
- **配色**：药丸底 = session 色混合渐变，文字白色。

**字体**：产品语言含中文，工具标题必须支持 CJK/emoji 字形和系统字体回退。方案：

- macOS：badge 文字用 Core Text（`CTLineDraw` 到位图）——系统字体栈自动
  覆盖 CJK/emoji，且免去内嵌字体资产与许可负担。
- Windows：`DirectWrite`（或 `DrawTextW` + 系统字体）同理，产品链 Helper
  已依赖 D3D/WGC 系，DirectWrite 无新增运行时负担。
- 两平台字体栅格都画进各自 overlay 表面（macOS 该组 layer 的位图内容 /
  Windows DIB），文字渲染平台分支、**布局/截断/时序逻辑保持共享**
  （`motion_math` 同级的纯函数：badge 布局宽度、省略号预算；无独立
  reveal 状态机——badge 跟随组可见性）。
- 字体族对齐产品 UI 字体（DESIGN.md 约定），非 Inter。

**不做 modifier chips**：本仓工具面
的 delivery/target 语义不对外（内部投递梯），没有对应的展示价值；badge
只显示标题文字，留 chips 为后续可选。

### 4.9 Gate：默认开启，留用户开关接口

需求：默认开启；未来可让用户自选（如上级要求在设置页加开关），接入成本低。
设计照抄仓库两个现成范式（用户决策：先默认开，不暴露设置项）：

**开关语义 = kill-switch（默认开，显式关）**，完全对齐
`--disable-cps-activation` 先例（`helperConstants.ts:71-88`，其动机注释直接
适用：改的是 native 可见路径，异常时需要不回滚构建就能关掉）：

```text
L0 契约   helperConstants.ts: HELPER_DISABLE_MULTI_CURSOR_OVERLAY_ARG
          = "--disable-multi-cursor-overlay"（缺省 = 开）
          + env 翻译 ZCODE_CUA_DISABLE_MULTI_CURSOR_OVERLAY →
          multiCursorOverlayDisableRequested(env)（只认显式 1/true/on/yes，
          唯一判定点，模式抄 cpsActivationDisableRequested）
L1 构造   helperLauncher.ts: HelperLaunchSpec.disableMultiCursorOverlay?:
          boolean（三值语义）→ buildHelperOpenArgs push
L2 注入   两条启动链都传（第六次漏传警示，先例五次）：
          产品链 cuaHelperHost.createProductCuaHelperHost options +
          懒启动链 computer-use-runtime.launchHelperApp
L3 Helper helperMain.ts argv.includes 解析 → native：
          关闭时 sessionId 路由旁路（全部动作落到 "default" 单光标），
          行为精确等于现状——旧代码路径天然保留为关闭态
L4 用户面 （本 spec 不做，接口预留）AppSettings 增
          computerUseMultiCursorOverlayHidden?: boolean（hidden 语义、
          undefined = 默认开，免数据迁移，模式抄 computerUseComposerEntryHidden）；
          desktop main 读设置 → desktopHostProcess env 注入区下发 → host 翻译
          进 createProductCuaHelperHost；构造期快照 + 重启 Helper 生效
          （与 ghostCursorOverlay/backgroundMode 同口径，不做热切换）
```

兼容性：旧 Helper 白名单式解析，未知 argv 安全忽略——「新 desktop + 旧
Helper」降级为现状单光标（特性 absent），「关」指令下发给旧 Helper 同样
无副作用。不做 broker 方法 / 不 bump IPC 版本。

### 4.10 多屏与坐标系：多光标多屏是硬要求

多屏要求（已有根因见 §3 表）：

1. **单窗跟随反馈屏（本仓现状）在多光标下失效**：两个 session 分居两屏，
   窗口只能跟一个，另一屏光标不可见——正是本仓修过的雷在多光标下复发。
   **决策：macOS 改每屏一窗**，每窗
   `contentsScale = 该屏 backingScaleFactor`，**跳过镜像屏**（mirrored display 共享源屏坐标）。
   跨屏 glide 边界跳变的已知代价随之消失（每屏都有窗）。
2. **本仓两个多屏不变量保留**：CG→NS 翻转基准一律
   `PrimaryScreenFrame()`（绝不用 `mainScreen`——那是 key window 的屏）；
   点不落任何屏时回退最近屏再回退主屏。
3. **禁止负数哨兵**（副屏在主屏左侧/上方时全局坐标为负，
   `pos < threshold` 形状的「未放置」判定必然误伤）：本仓 ghost 用真实
   CGPoint 无此问题，但新增的 motion/badge 状态**必须用显式
   `placed: bool`**（或对象封装），任何负坐标都是合法位置。
4. **坐标系分层与「显示位置 = 投递位置」**：
   - 光标状态永远存**全局逻辑坐标**（CG 左上原点 / Win32 虚拟屏物理像素）；
     绘制时减**屏/窗原点**再乘**该屏 scale**，两参数显式传递。
   - **显示位置 = 投递位置（同源构造）**：overlay 消费的坐标就是输入 fire
     点的同一全局坐标（mac `move_to_target` 的 x,y / win SendClickAt 落点），
     **不存在第二条坐标映射链**——从构造上杜绝「光标显示偏移于实际操作
     位置」类 bug；点→屏路由（决定绘制 scale 与遮挡探测归属）是绘制期
     查表，不改坐标值。
   - 输入侧的虚拟屏归一化（SendInput fence-post：
     分母是 `vw-1` 不是 `vw`）属输入层既有职责，overlay 不重复实现。
   - 新增纯几何模块（无 OS 依赖可单测）：屏枚举、点→屏路由（**半开区间** `>= x && < x+w`，接缝点
     恰好属一屏）、seed clamp 进**目标所在屏**的 frame（不是主屏）、每屏
     scale 作为 DisplayGeometry 一等字段。
5. **屏配置热插拔**：注册 reconfiguration 回调 + **generation 计数**，
   in-flight 帧失配即丢弃，整套窗口组原子替换（不做增量增删）。
6. **Windows：union 单窗保留，混合 DPI 靠绘制侧 per-cursor scale 一次解决**
   （不拆窗）。虚拟屏 union 单窗（`SM_*VIRTUALSCREEN`，负原点合法，origin
   减法即正确）不动；`UpdateLayeredWindow` 表面是**物理像素**、逐像素自绘、
   无 DWM 二次缩放——paint 时按「光标热点所在屏」的 scale（display_geometry
   提供）绘制光标与 badge，单窗内不同区域不同 scale 是普通像素操作。**为什么不拆**：
   macOS 拆窗是被平台逼的（NSWindow 单一 backingScaleFactor + Spaces 跨屏
   窗只上最大面积屏，均为本仓踩过的雷）；Win32 无此二约束，拆窗不带来额外
   像素正确性，反而 N 份 z 序重钉 / N 份 capture exclusion / 窗口组一致性
   记账。坐标层（全局坐标 − 屏原点 × 屏 scale）设计就绪，未来真要拆不返工。
   已知固有行为：光标跨混合 DPI 接缝时尺寸阶跃（100% 屏 42px → 200% 屏
   84px），按热点所在屏取 scale——两种窗口策略下都如此，macOS 亦然。
7. **每屏一窗的连带改造点**（本仓现行单窗假设逐项拆）：
   - 遮挡 probe 排除自身：`g_window_server_id` 单值 → 全部窗口 id 集合；
   - capture 开关（`ghostSetCapture`/display affinity 类）：对全部窗口生效；
   - `ghostState().windowFrame` 不变量：改为「光标所在屏的 frame」按组报告；
   - z 序（ScreenSaver 层 + orderFrontRegardless）：每窗独立执行；
   - 空闲 orderOut：**全部组隐藏**时所有窗才 orderOut（§4.7 对齐）。

**测试策略**：
布局/路由/映射全部抽成无 OS 依赖纯函数，表驱动覆盖负坐标（主屏左侧/上方
副屏）、混合 scale（2.0/1.0/1.5）、镜像屏、接缝点、热插拔 generation；macOS
live 用例沿用本仓多屏 spec 先例（每块活动显示器中心点移动，断言
`windowFrame`/可见性），Windows 真机验证放 P3 matrix。

## 5. 契约变更清单

| 层 | 变更 | 兼容性 |
| --- | --- | --- |
| broker 请求消息 | **（已落地，形态优于原案）**不新增顶层字段：`callBroker` 对全部工具动作消息注入既有 `pip_session_context`（此前仅 `capture_app`），内含 `session_id`（裸产品 sessionId）与新增可选 `action_title`（cell title，§4.8） | 老 Helper 忽略未知子对象 = 现状单光标；新 Helper 收不到字段 = `"default"` 组 / 无 badge |
| `ComputerUseRuntimeContext`（`src/tools/computer-use-runtime.ts`）+ `cua-bridge.ts` | **（已落地）**context 增可选 `actionTitle?: string`；`requestContext()` 从 requestMeta 保留 title；`requestMetaFor` 回传 snake `title` | 纯 TS 内部字段，无协议/契约变更 |
| `HelperNativeAddon` seam（`nativeAxSource.ts`） | **（已落地，优于原案）**不逐方法加参：seam 增可选 `ghostSetRequestSession / ghostSetMultiCursorEnabled / ghostSessionTurnEnd / ghostRemoveSession / ghostBeginActionWithTitle`；addon Proxy（`withGhostRequestSessionScope`）在指针类调用窗口内同步设 request scope | 可选方法，TS 侧向后兼容；旧 addon 缺方法时 Proxy 直通 |
| macOS `ghost_cursor.mm` NAPI/C ABI | 现有 13 个导出增可选 sessionId 变体（NAPI 可选属性；C 接口新增 `ghost_cursor_move_to_session(...)` 系列，旧签名保留为 default 转发） | 二进制面只增不改 |
| Windows `ghost_cursor_win.cc`（新） | 导出与 macOS 对齐的 ghost\* NAPI 面（带 sessionId；无 mac-only 的 focusRect/RenderPng 可后置）；`ax_win.cc` fire 点（SendClickAt / postMessage\* / hitTest 确定投递处）带 session 触发 | 新增导出，无兼容负担 |
| 根目录 `binding.gyp` | Windows 分支 sources 加 `ghost_cursor_win.cc`、`motion_math.cc`，补 `gdi32/user32/dwmapi` 链接；macOS 分支加 `motion_math.cc` | 只加源与库；**不改 `src/native/binding.gyp`（旧拷贝）** |
| argv（`helperConstants.ts` / `helperLauncher.ts` / Windows launcher 路径） | 现有 `--ghost-cursor-overlay/--ghost-cursor-capture` 不动；新增 kill-switch `--disable-multi-cursor-overlay`（默认开）+ env 翻译 `ZCODE_CUA_DISABLE_MULTI_CURSOR_OVERLAY`；`HelperLaunchSpec` 加 `disableMultiCursorOverlay?: boolean`，**产品链与懒启动链都传**（§4.9） | 旧 Helper 未知 argv 安全忽略 = 现状单光标；不 bump IPC 版本 |

## 6. 时序与状态图

### 6.1 多 session 并发 turn（目标行为）

```text
session-a (黄)                     session-b (粉)
    │ turn-started(a)                  │
    │ （仅 pending，不显示）            │
    │ move(a,x1) → a 组显示+滑行       │
    │                                  │ turn-started(b)（仅 pending）
    │                                  │ move(b,y1) → b 组显示（SEED 入场）
    │ move(a,x2) 顶替旧动画            │
    │ click(a) 涟漪(黄)                │
    │ turn-ended(a)                    │ move(b,y2)（不受 a 结束影响）
    │ a 组立即隐藏（组保留）            │
    │                                  │ turn-ended(b)
    │                                  │ b 组立即隐藏；全空 → 窗口 orderOut
遮挡（任意时刻，per-group 探测）：
  用户窗口盖到 a 的动作点 → a 组 alpha=0 + 丢弃 pending 涟漪；b 组不受影响
现状：macOS 全程只有一个光标互相覆盖位置；turn-ended 只要
anyTurnRunning=false 就全隐藏（布尔守卫）。Windows 全程无光标。
```

### 6.2 一次动作的双链路（输入与视觉解耦，双平台同构）

```text
agent ── node_repl js(code) ──▶ host：context.sessionId=sid（request-context）
                                            │ broker 请求 {…, sessionId: sid}
                                            ▼
                                       Helper broker server
                          ┌── 输入链（时序不变）────────┐
                          │ mac: AX press（确定投递后）   │──▶ ghost_fire(sid, x, y)
                          │ win: SendClickAt / PostMessage│         │
                          │     （确定投递后，物理 lane   │         ▼
                          │      语义与终止判定不动）     │  ghost 组 sid：贝塞尔滑行
                          └───────────────────────────────┘  + 朝向旋转
                                                （不等到达，不阻塞工具返回；
                                                 下一条命令顶替重规划）
```

### 6.3 session 关闭清理

```text
session-closed(sid) ──▶ coordinator ──▶ ghost_remove_session(sid)
                                         ├─ 组移出（mac：layer 树；win：RenderMap+表面）
                                         ├─ tombstone[sid] = YES
                                         └─ 迟到的 move(sid)/ripple(sid) → 丢弃
```

## 7. 分期实施与验收

每期独立可交付、独立可回滚（feature 无新 argv，回滚 = 撤销 native seam 调用）。
顺序刻意安排：路由与运动学核心先行平台无关化，Windows 期一次带全能力。

### P0：session 端到端路由 + turn lifecycle per-session 化 + gate（平台无关）

1. broker 动作消息透传 `sessionId`（来源 = `context.sessionId`，已流入，
   §4.1——SDK 主链路零上游改动）；`HelperNativeAddon` seam 加可选参数；
   mac fire 点带 session（先全部落到 `"default"` 单例，行为不变）。
2. （原「desktop/services sessionKey 注入」项删除——调研确认 SDK 链
   context.sessionId 已 per-request 到位，无需注入；独立 stdio/HTTP 入口
   的对齐属 standalone 场景，非本期。）
3. `ghostCursorTurnLifecycle.ts` per-session 化，删除 `anyTurnRunning` 布尔
   （对齐 §4.7：turn-ended 立即隐藏该组、turn-started 不显示）。
4. Gate（§4.9）：kill-switch argv + env 翻译 + 两条启动链 + helperMain
   解析（关闭 = sessionId 路由旁路）。不做采用率/使用情况统计。
5. 纯几何模块骨架（§4.10.4）：屏枚举/点→屏路由/seed clamp，per-display
   scale 字段一等公民（先供单窗路径使用）。

验收：双平台单测（路由透传/缺省回退/lifecycle 隔离/gate 默认开与
env-kill/旧 Helper 忽略）通过；全平台行为与现状无差异（光标仍单例）。

### P1：macOS 多实例 + 多颜色 + 每屏一窗

1. macOS overlay 改**每屏一窗**（§4.10：跳过镜像屏、每屏 contentsScale、
   热插拔 generation、单窗假设逐项拆——遮挡 probe 自身排除改 id 集合、
   capture 全窗生效、ghostState 按组报告、空闲全组隐藏才全窗 orderOut）；
   `PrimaryScreenFrame` 翻转基准与回退链保留。
2. `ghost_cursor.mm`：全局单例重构为 per-window `NSMutableDictionary<key,
   group>` + tombstone；default 路径行为不变；新增状态用显式 `placed`
   标志（禁负数哨兵）。
3. 颜色派生纯 C++（§4.5，含美术顶点共享头）+ macOS tint 接入。
4. 遮挡探测 per-group 化 + 整窗 opacity 下沉为组 opacity（§4.4 重构点）。

验收：两个 agent session 并发操作，屏幕两个不同色光标互不覆盖；**两 session
分居两屏时双屏各见其光标**（macOS live：每块活动显示器中心点移动断言，沿用
`ghost-cursor-multi-display-spaces.md` 的 live 模式）；单 session 场景与现状
无差异；`session-closed` 后无残留 layer；用户窗口盖住 a 的动作点 → 仅 a 组
隐藏（立即、涟漪丢弃），b 组不受影响。

### P2：运动学核心 + macOS 曲线/朝向

1. `motion_math.h/.cc` 纯 C++（§4.6），写成独立纯函数（无平台依赖）。
2. NAPI 增 `ghostMotionSelftest`：输入确定性场景返回位置/朝向序列，供 vitest
   数值断言（先写测试的落点）。
3. macOS per-group 状态机接入 tick；SEED 入场；新命令顶替。

验收：单次 move 可见弧线滑行 + 箭头转向 + 微回弹；连续 move 顺滑追赶无跳变；
不出现瞬移回归。

### P3：Windows overlay（复用 P0 路由 + P2 运动学，一次到位）

1. `ghost_cursor_win.cc`：§4.3 全套（窗口/软件光栅/脏矩形/三档节奏/z 序
   重钉/capture 排除）+ 多实例 RenderMap + 颜色 + 曲线 + 遮挡探测
   （§4.4：WindowFromPoint owner-walk，确定性立即/不确定 300ms 去抖）。
   虚拟屏 union 单窗（负原点合法，§4.10.6）；**per-cursor paint scale 接入**
   （光标/badge 按所在屏 DPI 绘制，混合 DPI 一次到位，不留 P4）。
2. 根 `binding.gyp` Windows 分支接线；`windowsInputDispatch.ts` fire 点带
   session；launcher argv 拼接。
3. Windows 侧 turn lifecycle 接线（P0 的 per-session 化在此平台生效）。

验收：Windows 真机双 session 并发操作，两个不同色光标曲线滑行互不覆盖；
`GetCursorPos` 前后对比真实指针不动（无输入泄漏）；用户窗口盖住某组动作点 →
仅该组隐藏；截图排除开关生效；空闲 CPU 占用可忽略（IDLE 档释放表面）；
混合 DPI 屏上光标按所在屏原生 scale 绘制（有混合 DPI 硬件时真机验证，否则
纯几何单测覆盖点→屏→scale 路由）。

### P4：badge + 打磨（双平台）

1. badge（§4.8 全套）：bridge context 增 `actionTitle`（cell title 进
   `ComputerUseRuntimeContext`）+ broker 同路 `actionTitle` + native badge 层
   + 系统字体文字渲染（macOS Core Text / Windows DirectWrite，CJK 必须有
   字形）；badge 可见性直接绑定组 alpha（无独立状态机，先写纯函数测试）。
2. reduced motion 跟随系统（mac/win 各自 API）。
3. 验证入场/退场动画细节（淡入、角落翻转）。
4. （Windows per-monitor DPI 已并入 P3——union 单窗 + per-cursor paint
   scale，§4.10.6；P4 仅剩真机混合 DPI 观感校准，如有硬件。）

验收：SDK 链路（node_repl cell）动作发生时光标旁出现标题药丸（文字为该
cell 的 `title`，中文正常渲染）；**cell 活跃期间文字常显，光标淡出/隐藏/
被遮挡时文字随之消失**（共用组生命周期，无独立残留）；同 cell 连续动作
文字不闪；指针悬停已淡出的组短暂回看文字；标题超长按像素截断到 `…`；
MCP 工具面直调（无 title）全程无 badge，光标/动画/遮挡/生命周期不受影响。

## 8. 测试计划（先测后码）

| 层 | 用例 | 位置 |
| --- | --- | --- |
| TS 单测 | 颜色派生稳定：同 id 恒同色；`agent-3`→板 3；单字母；FNV 分支 | `test/`（vitest，纯函数镜像实现 + 与 native 自测对照） |
| TS 单测 | turn lifecycle per-session：turn-ended **立即**隐藏该组（不再等 anyTurnRunning）；turn-started 不显示；closed 后墓碑丢弃迟到事件 | 重写扩展 `ghost-cursor-turn-lifecycle.test.ts` |
| native/live | 遮挡 per-session：确定性遮挡立即隐藏**仅该组** + 丢涟漪；不确定态 300ms 去抖不吞涟漪；一组淡出不带动他组（组 opacity 重构） | 扩展 native 契约 + macOS live 用例 |
| TS/native | badge：**与组生命周期同进退**（组隐藏文字即消失，无独立残留）、悬停回看、像素截断；中文标题有字形（CJK 渲染回归）；bridge context 透传 cell title；MCP 直调无 badge | P4，vitest 纯函数 + live 视觉验证 |
| TS 单测 | broker 消息带 sessionId 透传 / 缺省回退 default | `test/` broker 协议 |
| TS/native | gate：默认开；env-kill 三值语义（只认显式真值）；两条启动链都拼 argv（防第六次漏传）；关闭时 sessionId 旁路到 default；未知 argv 旧 Helper 忽略 | `test/` + helperLauncher 契约 |
| 纯几何单测 | 多屏：负坐标（主屏左侧/上方副屏）合法、点→屏路由半开接缝、seed clamp 进目标屏、混合 scale（2.0/1.0/1.5）、镜像屏跳过、热插拔 generation 失配丢弃 | 表驱动，无 OS 依赖 |
| native 契约 | NAPI 面扩展（mac per-session 变体、win ghost\* 全套存在、默认参数兼容） | 扩展 `test/native/ghost-cursor.test.ts` + 新增 win 契约 |
| 运动学数值 | `ghostMotionSelftest`：端点连续、切向朝向、spring 收敛、顶替重规划 | P2，vitest 数值断言（双平台跑同一断言） |
| macOS 真机 live | 双 session 并发移动互不干扰、颜色区分、关闭清理；**双 session 分居双屏各见其光标**（每屏中心点断言，沿用多屏 live 模式） | 仿 `test/native/ghost-cursor-feedback-live` 模式 |
| Windows 真机 | 双 session 并发（复用 `windows-harness-parallel-experiments.mjs` 双 MCP session 形态，P6 已验证）；真实指针不动；z 序/截图排除 | `test/matrix/` 新用例，`platforms:['win32']` + 三层门控，`*.cua.test.ts` 命名 |

## 9. 明确不做什么

1. **不加 MCP 光标工具**：本仓
   session 由宿主导，agent 不应自控光标样式；配置面只留现有 argv 开关。
2. **不引入 `.cua-theme` 主题生态**（dotLottie 编译/安装/CLI）：ghost 美术保留
   内置矢量绘制 + tint，重量级主题系统与产品形态不匹配。
3. **不改单写者模型**：`ControllerLease` 全局唯一 controller 不动；多光标只是
   展示层并发，输入投递仍经现有仲裁。
4. **Linux 不在本 spec 范围**：无 overlay，跨平台移植另立 spec。
5. **不做 arrival waiter**：工具返回不等待光标滑行完成。
6. **不替换 Windows 指示条**：指示条（全局「ZCode 在操作」状态）与光标
   （per-session 位置可视化）语义互补，并存；后续产品若要合并另议。
7. **不做相对 z 槽 pin**（`orderWindow:relativeTo:` / SetWindowPos 相对
   插入）：保留本仓「恒置顶 + 点位遮挡探测」模型——探测天然 per-cursor，
   规避单 z 槽多光标的遮挡矛盾（§4.4）。
8. **gate 不做热切换**：构造期快照 + 重启 Helper 生效，与现有
   ghostCursorOverlay/backgroundMode 口径一致；不为此加 broker 方法或
   bump IPC 版本（§4.9）。

## 10. 风险与待确认问题

风险：

1. **单例语义拆分的回归面**（macOS）：目标绑定探测（pid/windowId 像素归属）、
   遮挡去抖、多屏跟随、keyPulse/focus-rect 都要逐项 per-session 化；P1 需对照
   `ghost-cursor-revival-and-polish.md` 的时序耦合清单逐条回归。
2. **libuv 主线程约束**（双平台）：mac tick 与 Napi 同线程，多组动画 + 高频
   命令下注意 tick 合帧（一帧驱动全部组）；Windows 命令通道只投递不渲染，
   渲染全在窗口线程——两侧都不允许每组独立 timer。
3. **broker 消息扩展的版本协商**：新字段对老 Helper 必须无害（忽略未知字段），
   需确认 broker 协议解析端对未知字段的容忍行为后再定字段形态。
4. **动画与 `CATransaction` 冲突**（macOS）：位置改为手动采样后必须保持
   `setDisableActions:YES`，否则隐式插值叠加采样造成抖动。
5. **Windows z 序/定时器坑**：topmost 带滞留
   需显式 NOTOPMOST 归一；`SetWindowPos` insert-after 语义是「低于 target 一格」；
   默认 15ms 计时器分辨率会半速动画（dt clamp + ACTIVE 档 1ms 分辨率）；跨线程
   `SetTimer` 唤醒 IDLE。
6. **Windows 真机验证依赖**：matrix 用例只能 Windows 真机 + opt-in 跑，CI 无法
   守护——需在 mac 可跑的契约/数值测试补足下限。
7. **遮挡探测成本与共享快照**：多组若各自枚举窗口列表则成本 ×N；必须每探测
   tick 一次快照共享给全部组（§4.4），且探测只在有活跃组时运行。
8. **组 opacity 重构回归面**：整窗 opacity 下沉为组 opacity 后，idle 淡出、
   遮挡抑制、turn-end 立即隐藏三条路径都要走组 alpha——P1 需逐路径回归
   （`ghost-cursor-revival-and-polish.md` 的时序耦合清单同样适用）。
9. **每屏一窗改造回归面**（macOS）：现行单窗假设要逐项拆（遮挡 probe 自身
   排除、capture 开关、`ghostState().windowFrame` 不变量、z 序、orderOut
   时机，§4.10.7）；纯几何单测先行 + 双屏 live 验收是硬门槛，不做增量增删窗口（整套
   原子替换 + generation）。

待人工确认（实现前）：

1. **sessionKey 注入点（已确认，subagent 调研）**：SDK 主链路无需任何注入
   ——`trace.sessionId → request-context.session_id → context.sessionId`
   已 per-request 流入 Helper（cua-bridge 必填校验），`pip_session_context.
   session_id` 同为裸产品 sessionId，与 turn 事件同 key。光标 key 固定为
   裸 sessionId（§4.1）；`sessionKeyFor` 复合键与 `ToolDeps.sessionKey`
   均不混用。独立 stdio/HTTP 入口如需对齐（standalone 场景），注入点在
   `index.ts main()` 与 `http-server.ts` 建 session 处，非本期。
2. **displayName 不做**（已定）：badge 只在 SDK 链路显示 cell title；MCP
   直调/standalone 无 title 无 badge。`turn-started` 不加 `displayName`
   字段（协议保持零新增），§5 契约表相应行删除。
3. **reduced motion 跟随系统即可**（已定）：不加用户设置项；P4 按各平台
   系统 API 实现。
4. **Windows 指示条与光标并存**（已定）：语义互补（全局状态 vs per-session
   位置），本 spec 按并存设计；是否合并留待产品后续评估。
5. **描边策略已定**（同色系加深，见 §4.5）：P1 视觉验证时若个别浅色仍
   不达标，微调加深比例即可（不动色卡）。

## 11. 关键落点文件

- 共享：`packages/zcode-cua/src/native/motion_math.h/.cc`（运动学 + 颜色派生 +
  美术顶点，纯 C++ 双平台编译）、`display_geometry.h/.cc`（屏枚举/点→屏路由/
  seed clamp/per-display scale，纯几何）、根目录 `binding.gyp`（两平台 sources）
- gate：`src/broker/helperConstants.ts`（argv 常量 + env 翻译）、
  `src/broker/server/helperLauncher.ts`（HelperLaunchSpec）、
  `src/broker/server/cuaHelperHost.ts` + `src/tools/computer-use-runtime.ts`
  （两条启动链）、`src/broker/server/helperMain.ts`（argv 解析 → native）
- macOS：`src/native/ghost_cursor.mm`（多实例+曲线渲染）、`ax_macos.mm`
  （fire 点带 session）
- Windows：`src/native/ghost_cursor_win.cc`（新，§4.3 全套）、`ax_win.cc`
  （fire 点带 session）、`src/broker/server/windowsInputDispatch.ts`（触发接线）
- seam/路由：`src/broker/server/nativeAxSource.ts`（`HelperNativeAddon` 可选
  参数）、`src/backend/broker-client.ts`（动作消息带 sessionId，来源
  context.sessionId）
- 生命周期：`src/broker/server/ghostCursorTurnLifecycle.ts`（per-session 化）、
  `src/pip-session/coordinator.ts`（closed→remove）、`helperMain.ts`
- 宿主：`packages/services/src/zcode-agent/cuaOperationTurnTracker.ts`
  （turn 事件 sessionId 同源参照，无需改动）
- 测试：`test/native/ghost-cursor.test.ts`、`test/ghost-cursor-turn-lifecycle.test.ts`、
  `test/multi-cursor-overlay-gate.test.ts`、`test/multi-cursor-routing.test.ts`

## 12. 实施记录（2026-10-24）

状态：P0–P4 已实施（macOS 全量可用）；P3 Windows 代码就绪，真机编译与
验收待做（mac 开发机无法编 win 分支）。语义以 §1–§11 为准，本章只记录
落地事实、与原案的偏差和验证结论。

### 12.1 落地范围（对应 §7 分期）

- **P0 路由**：`callBroker` 对全部工具动作消息注入 `pip_session_context`
  （含 `action_title`）；Helper `brokerServer` 分派前建立请求级 ALS scope；
  `nativeAxSource` 的 addon Proxy 在指针类调用窗口内同步设 native request
  scope（`ghostSetRequestSession`）；键盘异步 worker（`InputWorker`）在
  **入队时拷贝 sid**、OnOK 用 `ghost_cursor_end_action_session(sid)` 显式收。
- **P0 生命周期**：`ghostCursorTurnLifecycle.ts` 重写为
  `withGhostCursorSessionLifecycle`；`anyTurnRunning` 布尔守卫删除。
- **P0 gate**：kill-switch argv + env 翻译 + 两条启动链 + helperMain 解析
  （关闭 = ResolveKey 恒 "default"，行为=现状）。
- **P1 macOS 多实例**：`ghost_cursor.mm` 重写——每屏一窗
  （CGGetActiveDisplayList 真相源、跳镜像屏、每屏 contentsScale、整套原子
  替换 + generation）、per-session layer group、组容器 opacity（idle×occlusion
  下沉到组）、遮挡探测 per-group（每 tick 共享一次窗口列表快照）、idle lease
  单全局 timer 扫 min-deadline（不允许每组独立 timer）。
- **P2 运动学**：`motion_math.h/.cc` 纯 C++；macOS 16ms 泵 timer 内一帧驱动全部组。
- **P4 badge**：cell title 全链路（§4.8 链路图）；badge 层挂组容器；macOS
  CATextLayer 系统字体（CJK 有字形）；两级截断（28 码点净化 + 188pt 像素宽）。
- **P3 Windows**：`ghost_cursor_win.cc` 全套（§4.3）+ `ax_win.cc` SendClickAt
  成功后 fire。**真机编译已过（2026-10-25 补 `dwmapi.h` include + C ABI 声明
  移出匿名 namespace）；启用链/fire 点补齐与真机验收 2026-10-26 完成**：
  move fire 补 `SendAbsoluteMove` 成功后（对照 `ax_macos.mm`
  `PublishGhostMoveForTarget` 范式，pid=0 走 `ghost_cursor_move_to`）、
  PostMessage click/drag 在 burst 成功后 fire `ghost_cursor_move_to_target`
  （pid/root 来自 request，与 macOS PostMessage 路径的
  `move_to_current_target` 同语义——后台模式真光标不动，ghost 走带 target
  的 move 才能驱动光标到点击位）；badge 走既有 addon Proxy
  （`withGhostRequestSessionScope`）的 `ghostBeginActionWithTitle`，native
  fire 点无需 session 参数（spec §5 第 1 条实现偏差的既定口径）。
  **2026-10-26 二轮真机修复（Windows 点击恒 default 蓝光标 + 前台点击挪走
  用户鼠标）**：
  (a) `GHOST_SESSION_SCOPED_METHODS` 名单补 Windows 的
  `postMessage*Async` 系（此前只有 macOS `*ToWindow` 系，名单空转）；
  (b) Windows AsyncWorker（PostMessage click/drag/前台 ClickAtPointAsync）
  fire 时 request scope 已被 Proxy 清空——对齐 macOS `_session` 变体范式，
  `ghost_cursor_win.cc` 增 `ghost_cursor_{move_to_target,click_ripple_target}_session`
  显式 sid 变体，NAPI 入队侧在 scope 窗口内经 `CaptureGhostSessionFromScope()`
  拷贝进 `request.ghost_session`；
  (c) 前台 SendInput 路径补真光标弹回（`SendClickAt`/前台 `Drag` 记
  `GetCursorPos` 快照，settle 后 `SetCursorPos` 恢复，用户指针只「闪一下」，屏幕上持续可见的只有 ghost
  会话色光标；纯 move/scroll 保留 hover 定位语义不弹回，mouseDown/mouseUp
  分离路径是用户显式控制也不弹）。
  **2026-10-26 三轮真机修复（表面像素齐全但屏幕不可见）**：自建 helper
  复现链（真实 argv 起 `dist/windows-helper.js` → broker pipe 发 `click`）
  + 表面内存 BMP dump 证明渲染管线全对（组/脏区/ULW present 正常、DIB
  内指针+涟漪像素完整），断点在 DWM 合成。两个根因：
  (a) **z 序沉底**——`RepinZOrder` 只发一次 `HWND_NOTOPMOST`，不保证带内
  位置，窗口被后续窗口压到 z 序底部完全不可见；修复无目标落位：`HWND_TOPMOST → HWND_NOTOPMOST` 瞬时双跳落到非 topmost 带最前
  （用户前台窗口仍在其上）。
  (b) **alpha 预乘**——`BlendPixel` 此前写直通（non-premultiplied）BGRA，
  ULW 的 `AC_SRC_ALPHA` 要求预乘；alpha<255 的像素（glow/描边/涟漪边缘）
  过曝或不可见；修复为混合在直通空间、落盘前乘 `out_a` 转预乘。另：CreateWindowExW 失败补 stderr
  日志（此前静默丢弃命令，排查代价极高）。验证：截屏 + 视觉模型确认
  蓝色指针（#1F8CFF 白描边）+ 涟漪在点击点精确呈现。

### 12.2 与原案的实现偏差

1. **session 注入点**（§5 原案是「broker 消息增 sessionId 字段 +
   HelperNativeAddon seam 可选参数」）：落地改为复用既有
   `pip_session_context` 扩展到全部动作消息 + Helper 侧 ALS scope + addon
   Proxy。**broker 消息面零新字段、native fire 点 C ABI 零签名改动**——旧
   Helper 忽略未知子对象 = 现状行为，兼容性优于原案。
2. **键盘异步 worker**：begin 在入队侧主线程（AppKit 线程约束照旧），sid
   随 worker 拷贝；end 在 OnOK 显式传 sid。
3. **色板哈希分布实测**：200 UUID 覆盖全部 11 色（9–27 次/色），碰撞率符合
   均匀期望；同屏两 session 同色是可接受的稳定哈希巧合（§4.5）。

### 12.3 新增 NAPI 面（双平台对齐）

`ghostSetRequestSession` / `ghostSetMultiCursorEnabled` /
`ghostSessionTurnEnd` / `ghostRemoveSession` / `ghostBeginActionWithTitle` /
`ghostBeginAction`（+可选 sid/title 尾参）/ 纯函数 selftest：
`ghostPaletteSelftest` / `ghostMotionSelftest` / `ghostGeometrySelftest`。

`ghostState()` 扩展：`multiCursorEnabled` / `sessionCount` /
`displayGeneration` / `windowFrames[]`（每屏）/ `groups{}`（每组
alpha/位置/颜色/动画/badge 明细）；顶层字段映射 default 组（旧断言兼容）。

### 12.4 验证

- 单测：`test/ghost-cursor-turn-lifecycle.test.ts`（per-session 重写）、
  `test/multi-cursor-overlay-gate.test.ts`（env 三值/argv 拼接）、
  `test/multi-cursor-routing.test.ts`（ALS/注入/兼容/截断）、
  `test/native/ghost-cursor.test.ts`（新导出 + 三个 selftest 数值断言）。
  affected 全量 916 用例通过；typecheck/lint/架构门禁无新增问题。
- macOS live 自验（本机）：双 session 各自显示/滑行/朝向/badge；turn-end
  只隐藏该组；remove+墓碑丢弃迟到命令；gate 关闭旁路回单光标；全部组
  隐藏后窗口 orderOut。
- 未验证项：Windows 真机（编译/双 session/混合 DPI/截图排除——代码就绪，
  待 `test/matrix` 真机跑）；macOS 双屏分居 live（单屏开发机，逻辑由
  display_geometry 表驱动单测覆盖）。

### 12.5 后续余项

- Windows 真机验收（§7 P3 验收清单）。
- Windows badge 文字渲染换 DirectWrite（当前 GDI 亮度近似 alpha）；macOS
  CATextLayer 已覆盖 CJK，Windows 用 Microsoft YaHei UI，均无内嵌字体。
- 用户设置页开关（如上级要求）：按 §4.9 L4 预案接入（AppSettings hidden
  布尔 → env 注入 → `multiCursorOverlayDisableRequested` 现成翻译点），
  desktop 侧小改动，不动 CUA 链路。

### 12.6 视觉修正（2026-10-25）

- **形状换装**：旧 22×28 三角箭头 → producer 内置的 8 顶点箭头
  轮廓（128 画布 → 42pt 足印，8 层柔光 + 白描边 + session 填充，§4.5）。
  顶点/分层表入 `motion_math.h` 共享；macOS 多层 `CAShapeLayer`（transform
  缩放 42/128 + 绕 tip 旋转），Windows `FlattenCursorArtPt` 折线 +
  `FillPoly`/`StrokePolyline` 软件光栅；旧热点环（bloom 层 / Windows
  FillRing 热点环）双平台删除。
- **落点根因修正**：`CursorMotion::MoveTo` 的 `kClickOffset=16pt` 移除。
  本仓 tip 锚定渲染下该偏移使 tip 落在点击点左上 11.3pt、涟漪圆心与 tip 错位。
  现落点 = 点击点，涟漪与 tip 同心（§4.6）。
- **badge 位置**：`kBadgeOffsetY` 25 → 45pt，避开 42pt 新美术的身体/glow
  （§4.8）；Windows 侧 `PaintBadge`/`PaintBadgeText` 两处硬编码 25.0
  一并改用共享常量。
- **截断补省略号**：字符级 28 码点截断时末尾补 `…`（27+…）；
  渲染级像素宽截断行为不变。
- **keyPulse 膨胀修复（2026-10-25 真机回归）**：换装后 dot 的 model
  transform 含画布→pt 缩放（42/128），`transform.scale` keyframe 动画直接
  挂 dot 时渲染按 ~1.0 替换缩放（Core Animation 对「model 已缩放 + scale
  动画」的合成语义不可依赖——model/presentation 读数正确但位图放大
  128/42≈3 倍）。修复：dot 外加 identity 包装层 `pulse`，动画（纯乘子
  1/0.92/1.03）挂包装层——identity 基底上替换语义 = 纯乘数，无歧义。
  Windows 软件光栅无此问题。

### 12.7 后台投递双光标修复（2026-10-25 真机）

现象：目标被遮挡（处于后台）时点击，屏幕出现**第二个 default 色光标**；
前台点击正常。根因两层，缺一不可：

1. **TS 名单漏**：`GHOST_SESSION_SCOPED_METHODS`
   （`nativeAxSource.ts`）没列 `*ToWindow(Async)` 系后台投递方法——
   addon Proxy 直通，`QueueBackgroundInput` 入队时 request scope 从未
   设置。
2. **native 异步落地缺显式 sid**：`BackgroundInputWorker` 跑在 libuv
   worker，视觉 fire（`PublishGhostMove/Click`）经 `dispatch_async` 落
   主队列时 scope 已清空，非 session 变体（`ghost_cursor_move_to_target`
   等）退到 `"default"` 组。

修复（对齐键盘 InputWorker 既有模式）：

- native：`ghost_cursor.mm` 新增显式 sid 变体
  `ghost_cursor_move_to_target_session` /
  `ghost_cursor_click_ripple_target_session`（`GroupForExplicitSession`：
  空/default → request scope，否则按 sid 懒建组 + tombstone 拦截）；
  `BackgroundInputRequest` 增 `ghostSession` 字段，入队时在 scope 窗口内
  拷贝，6 个 Action（click/move/scroll/drag/mouseDown/mouseUp）透传到
  `PublishGhost*`。
- TS：名单补 12 个后台方法名（begin/end 无视觉 fire 点不列入）；新增
  单测锁定「后台 fire 承载方法必须进 scope 名单」。

架构含义：**每个新的视觉 fire 承载路径都要同时接三层**——scope 名单
（TS）+ 入队拷贝（若有异步边界）+ 显式 session 变体（native fire 点）。
键盘 InputWorker、元素动作、后台投递三处现在同构。
- badge 时序契约不变（组生命周期，无自治淡出——用户决策维持 §4.8 原案）。
- 验证：`ghostMotionSelftest` 落点断言改为精确目标点（400/300）；
  `ghost-cursor.test.ts` sanitize 断言补 `…` 结尾；macOS `ghostRenderPng`
  离屏渲染目视核对新形状与 badge 间距。
