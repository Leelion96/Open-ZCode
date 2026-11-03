# Terminal Sessions

终端面板支持一个 workspace 下多个 terminal tab，并按 workspace identity 隔离保活。

## 手机软键盘输入（2026-10-23）

底部与侧栏终端共用以下输入契约。iOS / Android 软键盘的 `keydown(229)`
不保证文字已进入 textarea；已提交的 `input(insertText)` 必须按顺序、恰好一次送到
现有 xterm `onData → terminalService.write` 链路，不能依赖两次事件的时间间隔。
连续相同字母、空格、整段文本和 emoji 同样适用。

故障证据：xterm 5.5.0 在 keydown 后定时读取旧 textarea，随后又因看到 keydown
而忽略 composed input。真实 xterm 与历史输入处理代码的合成事件回放中，`abcdefgh` 仅送达 `ad`。
这是已确认的输入处理缺陷；尚未取得反馈手机的原生事件记录，不能把合成回放标为真机复现。

手机适配仅接管非组合状态的 229 输入事务：阻止该 keydown 进入 xterm 的定时读取路径，
由随后的已提交 input 写入一次。`compositionstart` 将该事务交还 xterm；候选文字不提前写入，
由原有 composition 链路提交。非空 `compositionend` 后仍等 xterm 发出 `onData` 才接管下一次输入，
避免同轮后续字母清空尚未提交的中文；空候选取消则直接释放。PTY 状态查询的 ESC 响应不算组合提交。
普通物理键、快捷键、粘贴沿用原链路。
软键盘删除须保留退格语义，不能因 textarea 已清空而失效。

软键盘也可能以 `keydown(229) → input(insertLineBreak)` 提交回车，且不发出
`keypress`。手机输入事务须把该换行转换为一次 `\r`，仍经原 `onData` 写入 PTY。
若同一事务已产生可由 xterm 处理的 `keypress`，则交还输入处理权，后续 input 不得重复发送。
根因是接管 229 后只处理文字和删除，导致没有 keypress 的换行失去原 xterm 读取路径。

```text
修复前：手机 keydown(229) → xterm 定时读取旧值 → input 被忽略 → 丢字
修复后：手机 keydown(229) → 手机输入事务 → 已提交 input → xterm.input → 原 onData → PTY
                                      └─ compositionstart → xterm 原组合输入链路
桌面：原 keydown / input / composition → xterm → 原 onData → PTY
回车：手机 keydown(229) → insertLineBreak → xterm.input("\r") → 原 onData → PTY
                       └─ keypress → 交还 xterm → 后续 input 不重复发送
```

适配监听的 owner 是 xterm 实例。侧栏 detach / reattach 不新增监听；最终 dispose 时解除监听，
不会向旧 PTY 写入。平台依据浏览器运行环境，不能依据远程 PTY 操作系统或屏幕宽度。
Windows 既有输入补偿与去重不变；Linux 桌面不启用手机适配，也不重新启用 Windows 补偿。
不改依赖版本、Host / relay、终端 owner 或持久化协议。

回归：`packages/ui/test/browser/manual-review/pending/terminal-mobile-input.test.mjs`
驱动真实 TerminalSession DOM，观察 terminalService 写入及终端回显；覆盖两种终端生命周期、
手机 229 事件先后顺序、重复字母、空格、emoji、中文组合提交、删除、普通键盘，以及 Windows/Linux 对照。
现有 `conversation-session-web-remote-terminal.test.ts` 增加手机软键盘事件到真实 PTY 的执行断言。
TMI11/TMI12 分别覆盖底部与侧栏终端无 keypress 的回车、带 keypress 的单次回车，以及普通 Enter 对照；
MRO04 的手机软键盘命令也用 229 + insertLineBreak 提交，不能用普通 Enter 代替该回归路径。
浏览器 UA / 平台模拟不等于 Windows/Linux 原生输入法或实体手机验收。

## 功能变更摘要

| 字段         | 内容                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| 变更         | 首个 terminal tab 不显示 `1`；后续 tab 从 `2` 开始；关闭或 PTY 退出时同步关闭对应 tab |
| 用户可见位置 | 底部 Terminal 面板的 tab strip                                                        |
| 状态 owner   | `Terminal` renderer 本地状态；PTY 生命周期由每个 `TerminalSession` 管理               |
| 不在范围内   | 右侧 side pane Terminal tab、聊天 session/task realtime、协议与 Host/Agent runtime    |

## 产品行为

核心规则：

- workspace key 使用 `workspaceIdentity?.trim() || workspacePath`，只用于终端会话隔离。
- `workspacePath` 只作为 PTY 的 cwd 传给 `terminalService.create()`。
- 收起终端面板或切换 workspace/task 不会 dispose 已创建的 terminal tab。
- 任意 terminal tab 的关闭按钮都会删除对应 session 并卸载 `TerminalSession`，从而 dispose 后端 PTY；关闭最后一个 tab 时同时收起空面板。
- Terminal 面板右上角关闭按钮只收起面板，不卸载 session。重新打开面板时继续使用原 session。
- Tab 与 Side Header 使用相同的 ghost 风格：无可见边框，选中背景 hover 不变，4px 间距；内容溢出用 mask 淡出、不使用省略号。关闭按钮参与普通 flex 布局，仅选中、hover 或 focus-within 时显示，隐藏时保留占位；mask 不随按钮显示状态移动。「终端」标题保持原样，shell 名称采用普通辅助文字，不使用 pill 样式。
- shell/PTY session 自身退出时自动关闭对应 tab；普通子命令返回非 0 但 shell 仍存活时不关闭。
- 多 tab 中的后台 session 退出时只移除自身，不改变当前活动 tab；活动 session 退出时沿用手动关闭的相邻 tab fallback。
- 当前 workspace 的最后一个 session 退出时移除已结束的 session 并关闭整个 Terminal 面板；下次打开时才懒创建一个全新 session，不保留 `[进程已退出]` tab。
- 隐藏 workspace 的最后一个 session 退出时只清理该 workspace 的 terminal state，不关闭当前 workspace 的 Terminal 面板。
- terminal 启动失败不属于 PTY exit；错误内容继续留在 tab 中供排查。
- 关闭 workspace tab 后，面板会根据仍打开的 workspace key 回收隐藏终端，避免后台 PTY 泄漏。
- 打开终端面板、切换 terminal tab、或新建 terminal tab 后，当前可见的 xterm 必须自动获得键盘焦点；隐藏的 workspace/session 不抢焦点。
- 拖拽调整底部终端高度时，xterm fit 和后端 PTY resize 不能按每个 `ResizeObserver` 回调同步执行；拖拽中按 `TERMINAL_RESIZE_DRAG_THROTTLE_MS` 低频预览，松手后立即 flush 最终尺寸，并对相同 `{ cols, rows }` 去重，避免 Windows / PowerShell 下连续 resize 卡住 UI。
- tab 展示名使用对应 session 的 cwd 叶子名；首个编号 `1` 不显示，例如 `z-code`。编号 `2` 及以后显示为 `z-code 2`、`z-code 3`。
- tab 名称在创建后保持不变。关闭其他 tab 不会触发已有 tab 重命名。
- 新建 tab 使用当前 workspace 内最小可用正整数编号。关闭 `z-code 2` 后再次新建，名称仍为 `z-code 2`。
- 终端输出中的 `http://` / `https://` 明文链接通过 xterm link provider 识别，hover 时显示下划线和手型，点击后复用 UI 层的 `onOpenBrowserUrl` 打开右侧浏览器；Web 端仍走现有新标签 fallback。

状态与事件顺序：

```text
首次打开                         新建
面板关闭 ──open──> [z-code] ─────────────> [z-code] [z-code 2]
                       │ tab close                 │ close z-code 2
                       ▼                           ▼
                  删除 session                  [z-code]
                  dispose PTY                       │ new
                  面板关闭                          ▼
                       │ reopen              [z-code] [z-code 2]
                       ▼
                   新建 [z-code]

面板打开 ──panel close──> 面板关闭（session / PTY 保活）──reopen──> 原 session

[z-code] [z-code 2] ──close z-code──> [z-code 2]
                                         │ new（已有名称不变，复用最小编号 1）
                                         ▼
                                   [z-code 2] [z-code]

[z-code] [z-code 2] ──PTY exit 2──> [z-code]
         │
         └─PTY exit 1（最后一个）──> 删除已结束 session ──> 面板关闭
                                                            │ reopen
                                                            ▼
                                                     新建 [z-code]

子命令 exit code != 0 ──shell 仍存活──> tab 不变
```

## 澄清记录

| 轮次 | 问题                      | 用户答案                                       | 固定边界                                        | 后续确认 |
| ---- | ------------------------- | ---------------------------------------------- | ----------------------------------------------- | -------- |
| 1    | 单 tab 关闭后的状态       | 关闭整个终端页面                               | 删除最后一个 session 并释放 PTY，然后收起空面板 | 否       |
| 1    | tab 基础名称与编号        | 当前 workspace 名；第二个为 workspace 名加 `2` | 编号 `1` 不显示，编号 `2` 起显示                | 否       |
| 1    | 关闭其他 tab 后是否重命名 | terminal 一旦创建就不改名                      | 名称随 session 生命周期稳定                     | 否       |
| 1    | 关闭编号 `2` 后再次新建   | 仍为 terminal `2`                              | 使用当前最小可用编号                            | 否       |
| 2    | 哪种 exit 自动关 tab      | 只在 terminal session 自身结束时               | 子命令失败不触发；正常和异常 shell exit 都触发  | 否       |
| 2    | exit 后是否保留提示       | 不保留                                         | 收到 PTY exit 后立即移除 tab                    | 否       |
| 2    | 最后一个 session 退出     | 关闭整个面板，下次打开新建 terminal            | 不保留已退出 session，也不在后台立即拉起新 PTY  | 否       |
| 2    | 后台与活动 tab 退出       | 后台只移除自身；活动 tab 切换到相邻 tab        | 不因后台 tab 退出抢焦点                         | 否       |
| 2    | terminal 启动失败         | 保留错误信息                                   | 启动失败不按 PTY exit 自动关闭                  | 否       |

## 领域范围与高风险交叉项

| 领域                                | 是否包含   | 决策                                                                                                    |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| File/Git/Terminal UI                | 是         | 修改底部 Terminal tab 的 renderer 本地命名、关闭与编号分配                                              |
| UI shell / responsive               | 是         | 桌面端与手机 Web 共用 `Terminal` 组件，行为保持一致，不增加单端分支                                     |
| Workspace identity / remote runtime | 代表性验证 | workspace identity 非空时优先用于隔离，否则回退 workspace path；`workspacePath` 仍只用于 cwd 和名称显示 |
| Mobile replayable / conversation    | 剪枝       | 不修改 session/task stream、snapshot、queue、protocol 或 delivery kind                                  |
| 右侧 side pane Terminal             | 剪枝       | 已有独立 tab 模型，本次不修改                                                                           |

## 概念图与状态 owner

| 概念                        | 权威状态 / 代码入口                                         | 可观察证据                                                 |
| --------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| workspace terminal registry | `packages/ui/src/Terminal.tsx` 的 renderer state            | 当前 workspace 的 tab strip                                |
| session 编号与最小可用编号  | `packages/ui/src/terminal/terminalPanelState.ts`            | tab 标题和纯状态单测                                       |
| PTY 生命周期                | `packages/ui/src/terminal/TerminalSession.tsx`              | tab X 删除 session 后组件卸载并 dispose PTY；面板 X 只隐藏 |
| 面板开关                    | `packages/ui/src/hooks/useAppPanels.ts` 的 `isTerminalOpen` | Terminal 面板显隐                                          |

## 状态维度与候选组合

| Case ID     | tab 状态               | 用户动作              | 预期效果                                         | 分类     |
| ----------- | ---------------------- | --------------------- | ------------------------------------------------ | -------- |
| TERM-TAB-01 | 首次创建，只有编号 `1` | 查看 tab 标题         | 显示 workspace 名，不显示 `1`                    | accepted |
| TERM-TAB-02 | 已有编号 `1`           | 新建 tab              | 新 tab 显示 `workspace 2`；首个 tab 名称不变     | accepted |
| TERM-TAB-03 | 已有编号 `1`、`2`      | 关闭编号 `2` 后再新建 | 新 tab 复用编号 `2`                              | accepted |
| TERM-TAB-04 | 已有编号 `1`、`2`      | 关闭编号 `1`          | 编号 `2` 保持原名，不改成基础名称                | accepted |
| TERM-TAB-05 | 只有一个 tab           | 点击 tab 关闭按钮     | 删除 session、dispose PTY 并收起空面板           | accepted |
| TERM-TAB-06 | 多于一个 tab           | 关闭任意 tab          | 只释放目标 session；若关闭活动 tab，选择相邻 tab | accepted |
| TERM-TAB-07 | 多 tab，后台 PTY 存活  | 后台 PTY exit         | 移除退出 tab，活动 tab 与焦点不变                | accepted |
| TERM-TAB-08 | 多 tab，活动 PTY 存活  | 活动 PTY exit         | 移除退出 tab，激活相邻 tab                       | accepted |
| TERM-TAB-09 | 当前 workspace 单 tab  | PTY exit 后重新开面板 | 先关闭面板；重新打开时创建全新基础名称 tab       | accepted |
| TERM-TAB-10 | 隐藏 workspace 单 tab  | 隐藏 PTY exit         | 只清理隐藏 workspace，不关闭当前面板             | accepted |
| TERM-TAB-11 | shell 存活             | 子命令返回非 0        | 不产生 PTY exit，tab 保持                        | pruned   |
| TERM-TAB-12 | terminal create 失败   | Promise reject        | tab 保留启动错误，不自动关闭                     | accepted |

剪枝决定：主题、locale、桌面/手机 viewport 不改变命名与关闭状态机，只保留共享组件的代表性断言；本次没有协议、provider fixture、网络时序或 Docker 隔离需求。

## 覆盖计划

| Case                 | setup / action / assertion                                                                        | 证据层                                           | 状态                       |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------- |
| TERM-TAB-01/02/03/04 | 构造 workspace terminal state，执行创建/关闭并断言稳定编号与标题                                  | renderer state + UI label helper                 | covered unit + runtime CDP |
| TERM-TAB-05          | 单 session 点击 tab X，断言 session/workspace 删除、PTY dispose、面板收起；重新展开创建新 session | renderer state + mounted lifecycle + desktop E2E | covered unit + desktop E2E |
| TERM-TAB-06          | 多 session 触发关闭，断言目标 session 删除、fallback active session 正确                          | renderer state                                   | covered unit + runtime CDP |
| TERM-TAB-07/08       | 多 session 触发 PTY exit，断言后台/活动 tab 的删除和 active fallback                              | renderer state + exit event                      | covered unit + runtime CDP |
| TERM-TAB-09/10       | 当前/隐藏 workspace 最后一个 PTY exit，断言面板关闭边界与懒重建                                   | renderer state + panel callback                  | covered unit + runtime CDP |
| TERM-TAB-11/12       | 子命令失败不产生 exit；create reject 继续保留错误 tab                                             | terminal service/event contract                  | covered by invariant       |

E2E 交接：该变更不发送 provider 请求，不需要 replay/file fixture；桌面 E2E 直接区分 tab X 与面板 X，断言唯一 tab 关闭后旧 xterm 卸载、面板收起，重新打开时创建新 session，并避免把右侧 side pane Terminal 纳入同一 case。

文件分层：

- `packages/ui/src/Terminal.tsx`：终端面板、workspace 会话注册表、tab UI。
- `packages/ui/src/terminal/TerminalSession.tsx`：单个 xterm 实例和后端 PTY 生命周期。
- `packages/ui/src/terminal/terminalPanelState.ts`：terminal tab/workspace 状态的纯数据辅助函数。
- `packages/ui/src/terminal/terminalLinks.ts`：terminal buffer 中 HTTP 链接识别和 xterm range 计算。
