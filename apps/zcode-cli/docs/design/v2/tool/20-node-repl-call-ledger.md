# node_repl 调用账本：结果里的可信事实只出自 Worker 之外

## 背景

`mcp__node_repl__js` 每次调用都在 node-repl-host 进程里新开一个 Worker，执行模型写的 JavaScript
代码（下称 cell）。Worker 里除了 cell，还有宿主的 bridge（浏览器、Computer Use）和收尾代码；收尾代码
把运行结果经 `worker_threads.parentPort` 发给主线程，主线程把**第一条消息**当作结果，组装成 MCP
工具结果。

结果的 `_meta` 里有几项被下游当作可信事实使用：

| key                                                     | 下游用途                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `zcode/nodeReplCuaApp`                                  | 工具卡显示被操作应用的图标（`docs/cua/cua-tool-app-identity-summary.md`）                                   |
| `zcode/browserScreenshotContentIndices`                 | core 据此判断哪些图片是模型显式截的浏览器截图，决定是否落盘原图                                             |
| `zcode/nodeReplBrowserUse`、`zcode/nodeReplComputerUse` | core 据此打会话能力标签 `browser_use` / `computer_use`（`docs/design/v2/model/session-features-header.md`） |

原来这几项由 Worker 里的 bridge 记进运行状态，再随结果消息发给主线程（后两项由 MR !3207 新增，初版
同样如此）。cell 能用完整的 Node `require`：它可以经
`require("node:worker_threads").parentPort.postMessage(...)` 抢先发出一条冒充的结果，主线程无法分辨，
这些事实都能被伪造（MR !3207 评审 CR-01）。vm 不是安全沙箱
（`core/src/repl/node-repl-session.ts`），Worker 内不存在 cell 写不到的通道：私有 MessagePort 也
可能经改写 `MessagePort.prototype` 被截获，所以修复不能留在 Worker 里。

另外，两个 broker 原来直接采信请求里的 `sessionId`、`runtimeScope` 等会话信息。cell 绕过 bridge、
直接往 broker 发请求时，可以冒充别的会话，或者在 subagent 里冒充主会话。

## 目标

- 可信事实只由主线程在**真实收到调用请求**时记录，冒充 Worker 的结果消息不能让它成立。这条保证的范围见
  「可信边界」：cell 仍可经 `node:inspector` 影响主线程。
- broker 使用的会话信息只来自 core 发出的 MCP 请求（`com.zcode/request-context`），不采信 Worker 自报的值。
- 模型可见行为不变：工具结果的内容、错误文案、浏览器和 Computer Use 的执行结果都与原来一致。

## 非目标

- 不改变其他 `_meta` key 的可信程度。`zcode/browserUse`、`zcode/toolSurface`、
  `zcode/browserTurnScreenshot` 等仍由 Worker 写入，仍然可以被 cell 伪造；它们不作为可信事实。
- 不阻止 cell 直接连 broker 发请求：那本身就是一次真实调用，账本照常记录。
- 不处理 core 里的内置 `js` 工具（`core/src/tool/handlers/node-repl.ts`）。它不在生产路径上，
  `NodeReplSession` 的记录接口保持不变供它使用。

## 设计

```text
node-repl-host 主线程（可信）                                       Worker（cell 与 bridge，不可信）
──────────────────────────────────────────────                 ──────────────────────────────
tools/call ──▶ ledger.open(requestMeta) ──▶ 本次调用的 token ──workerData──▶ bridge
                                                                       │
CUA broker  ◀──────── { token, method, input } ────────────────────────┤
  │ token → 账本条目；会话信息取自条目的 requestMeta                        │
  │ 收到请求即记 facts.computerUse（含被拒绝的）                       │
  │ subagent → 拒绝；执行；从响应记录目标应用 → facts.cuaApps              │
  ▼                                                                    │
CUA Helper                                                             │
浏览器代理 broker ◀── { token, op, … } ────────────────────────────────┘
  │ token → 账本条目；会话信息取自条目的 requestMeta；换成上游 token
  │ list / execute 即记 facts.browserUse；转发，截图响应 → facts.browserScreenshots
  ▼
ZCode 主进程的浏览器 broker（bootstrap）

Worker 结果消息（可能被冒充）──▶ toMcpRunResult(run, facts)
                                   可信 key 只取 facts，忽略 run 里的同名字段
tools/call 结束 ──▶ ledger 条目关闭：之后带这个 token 的请求一律拒绝
```

### 账本与 token

- 每次 `js` 调用开一个账本条目，生成一个只属于本次调用的随机 token，经 `workerData` 交给 Worker。
  它替代原来整个进程共用的 CUA broker token；浏览器 bridge 原来从环境变量读上游 token，现在同样
  改用本次调用的 token。
- broker 收到请求后按 token 找到条目。找不到（伪造、过期）就拒绝，文案与原来的 token 校验失败一致。
- 条目在 `tools/call` 结束时关闭。超时、取消后迟到的请求不会再被受理，也不会改写已经返回的结果。
- cell 只拿得到自己这次调用的 token，所以最多只能让自己这次调用多记一笔真实调用，影响不到别的会话或调用。

### CUA broker

- 会话信息（`sessionId`、`runtimeScope`、workspace、`turnId`、trace 等）由 broker 按条目的
  `requestMeta` 构造。构造规则从原来的 Worker 侧 `requestContext` 原样移过来，缺字段时的报错文案不变。
  Worker 只发 `{ id, token, method, input }`。
- 条目的 `runtimeScope` 为 subagent 时，broker 拒绝并返回 `Computer Use is not available in subagent`。
  Worker 侧原有的同名检查保留，正常路径的行为不变；broker 的检查兜住绕过 bridge 的请求。
- token 解析出条目后，立即把 `facts.computerUse` 记为真，记在校验请求格式和 subagent 检查之前：被拒绝的请求、
  runtime 抛错、结果 `isError` 都算一次真实尝试（会话能力标签 `computer_use` 的口径，见
  `session-features-header.md`「BUA/CUA 标签的补充规则」）。没到达 broker 的尝试（只做了 SDK 引导、Worker 侧
  bridge 的 subagent 拒绝）不记。
- 目标应用身份在 broker 拿到 runtime 结果时从 producer 的 `app-associations` 读取，规则与原来
  bridge 侧的 `readPrimaryAppIdentity` 相同：只取 `primary`，一个 cell 内后出现的覆盖先出现的。

### 浏览器代理 broker

- 主线程新增一个本机 socket 服务（Linux/macOS 为 `.sock` 文件，Windows 为命名管道），转发 Worker 的
  浏览器请求到 ZCode 主进程的浏览器 broker。上游地址和 token 仍由 ZCode 经环境变量
  `ZCODE_NODE_REPL_BROWSER_BROKER_SOCKET` / `_TOKEN` 交给 node-repl-host，只在主线程读取；
  启动 Worker 时从它的环境里去掉这两个变量。
- 转发时用条目的 `requestMeta` 重写 `runtimeScope`、`sessionId`、`turnId`、trace，并换成上游 token。
  其余字段原样转发，上游的 schema 校验与错误不变。
- 上游未配置时直接返回 `Browser control is unavailable for this node_repl session`，与原来 Worker 侧
  的文案一致。超限文案也按方向沿用原说法：请求超过 1 MiB 为 `Node REPL browser broker request exceeded 1 MiB`
  （原上游 broker 的文案），响应超过 32 MiB 为 `Browser broker response exceeded the 32 MiB limit`（原 Worker 侧
  bridge 的文案）。
- 代理跑在所有会话共用的主线程上，读行的开销必须随数据量线性增长：数据块先存数组，只在新到的块里找换行，
  找到后一次性拼接；只有 screenshot 命令的响应才解析 JSON，且只解析一次，转发的仍是原始字节。
- token 解析出条目、`op` 为 `list` 或 `execute` 时，立即把 `facts.browserUse` 记为真，记在检查上游和转发之前：
  上游报错、命令 `ok: false` 也算一次真实尝试（会话能力标签 `browser_use` 的口径）。
- 响应原样转发给 Worker。`execute` 的 `screenshot` 命令成功并带图片时，把图片记入 `facts.browserScreenshots`。
- Worker 一侧连接断开时关闭上游连接；浏览器 broker 已把对端断开当作取消。

### 结果组装

`toMcpRunResult(run, facts)`：

- `zcode/nodeReplCuaApp` 取 `facts.cuaApps` 的最后一个；`run.cuaApp` 忽略。
- `zcode/browserScreenshotContentIndices` 用 `run.images` 与 `facts.browserScreenshots` 逐字节匹配得出
  （匹配规则与 `NodeReplSession` 原有的规则相同，抽成 core 的公开纯函数复用）；`run.browserScreenshotImageIndices`
  忽略。cell 即使冒充结果、在 `images` 里放进真实截图的字节，被标出的也确实是那张截图。
- `zcode/nodeReplBrowserUse`、`zcode/nodeReplComputerUse` 只在 `facts.browserUse`、`facts.computerUse` 为真时
  写 `true`；`run` 上没有对应字段，冒充的结果消息里带上同名字段也不采信。
- 对 sandbox meta 通道（`setResponseMeta`、`emitStructuredResult`、内嵌 `_meta`）写入的同名 key 先删除，
  处置与原来相同。

## 可信边界

- 账本里的每一笔都对应一次到达主线程 broker 的真实请求。冒充 Worker 结果消息不能让账本多出任何记录。
- **已知缺口：cell 可以经 `node:inspector` 影响主线程。** Worker 里的代码能用
  `inspector.Session#connectToMainThread()` 连到 node-repl-host 主线程的 inspector，在主线程执行代码，进而改动
  账本、结果组装或读取主线程的环境变量（MR !3219 评审 SG-01，已实测可行）。这个能力在引入账本之前就存在，
  不是账本引入的。在它堵住之前，账本只能防住「冒充 Worker 结果消息」这一条路径，不能当作对 cell 的强保证。
  - 当前取舍：受影响的只是统计信号与工具卡展示，不涉及权限；触发需要刻意编写这类代码。
  - 不在 cell 的模块加载里禁用 `inspector` 系列模块：`node_repl` 是通用 JavaScript 执行工具，依赖
    inspector 的库（性能分析、覆盖率采集等）会因此报错，影响用户的正常使用；而且 cell 与 Worker 同 realm，
    禁用只能提高门槛，不能保证没有别的办法绕开。
  - 根本解法是把 cell 移到独立子进程执行：子进程的 inspector 与 node-repl-host 隔离。这要重写 node_repl
    的执行模型（进程启动开销、bridge 通信、超时、取消、kernel 重置），作为后续方向单独评估。
  - 在此之前，新增建立在账本之上的能力（例如会话能力标签）时，要按这条缺口评估影响。会话能力标签的两个
    key 已按此评估：受影响的只是统计信号（`session-features-header.md`「BUA/CUA 标签的补充规则」）。
- cell 可以自己连 broker 的 socket，用本次调用的 token 发请求：这是真实调用，记录成立。
- cell 若从别处拿到上游浏览器 broker 的地址和 token（例如读进程的初始环境 `/proc/self/environ`），
  可以绕过代理直接调用浏览器。这时调用真实发生但账本没有记录，只会少记，不会多记；会话信息的冒充
  问题在这条路径上仍然存在，需要上游 broker 自己按调用鉴权才能解决，不在本文档范围内。

## 验证

- 账本：token 只对本次调用有效；条目关闭后同一 token 被拒绝；不同调用的事实互不串扰。
- CUA broker：未知 token、共用旧 token 被拒绝；会话信息取自条目而非请求；subagent 条目被拒绝；
  目标应用身份记入条目；Worker 发来的 `context` 被忽略；有效 token 的请求（含 subagent 拒绝、runtime 抛错）
  记 `computerUse`，未知 token 不记。
- 浏览器代理：上游收到的是上游 token 与条目的会话信息；截图记入条目；上游未配置时返回原文案；
  Worker 断开时上游连接被关闭；未知 token 被拒绝；`list`、`execute`（含上游 `ok: false`、上游断开）记
  `browserUse`，未知 token 不记。
- 结果组装：`run.cuaApp`、`run.browserScreenshotImageIndices` 被忽略，可信 key 只取 facts；sandbox 通道写入的
  `zcode/nodeReplBrowserUse`、`zcode/nodeReplComputerUse` 被删除。
- 真实 Worker 回归（`bundle-smoke.test.ts`）：cell 经 `worker_threads` 冒充结果，带上 `cuaApp`、截图下标、
  `browserUse` / `computerUse` 字段和两个会话能力 key，工具结果里不出现这四个可信 key。
