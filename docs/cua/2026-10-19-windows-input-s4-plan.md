# Windows 输入派发 S4：文本 / 键盘 / 滚动 / 拖拽 / 后台并发 实施计划

> 状态：计划（2026-10-19）。前置：S3 v3 极简架构已落地（见
> [总纲](./2026-10-13-windows-input-delivery-spec.md) v3 契约与提交
> "Windows click dispatch — AX ladder, host routing, physical lane"）。
> 第三方许可归属：trycua/cua `libs/cua-driver/rust/crates/platform-windows`（commit 83f142c42，MIT）。

## 0. 本项目设计决定

1. 为可投递宿主提供 PostMessage 键盘中间级，经 Win32 焦点子窗口解析确定目标；
   XAML 加速键使用 UIA 通道，前台 SendInput 仅在显式指定或允许升级时执行。
2. 后台 scroll 先做真实宿主探针。SB 码族与滚轮消息分开验证，只有证实消费的路径接入。
3. drag 的驻留、步进、释放与 settle 分路径验证，数值以本项目常量和矩阵证据为准。
4. type/set_value 采用写前快照、写入与读回裁决；替换与插入使用不同判据，
   Chromium UIA echo 不作为 renderer 已生效证明。已发送或可能发送的动作禁止重放。

## 1. 范围

S4 交付六项（依赖顺序）：

| # | 项 | 交付物 | 解锁 |
| - | -- | ------ | ---- |
| 1 | WM_CHAR 文本插入中间级 | `type(strategy=event)` 插入语义后台交付 | 矩阵 S4 锚点格转绿（登记 2 用例；**实际可转绿格 = 4 宿主 × 2 = 8 格**——2026-10-19 实施确认：fixture 的 `text_input` 场景仅 wpf/winui3/winforms/qt6 四宿主具备，gtk3 元素路径已随 2026-10-18 探针决策删除（恒 unresolved），webview/electron/tauri 无该场景且属 Chromium 文本丢弃类（D1 前台化），锚点 `path=post_message` 断言在这些宿主结构性不可绿；与 §9 出口的「8 锚点格」口径一致） |
| 2 | type/set_value 读回裁决 | readback + effect 分档 + echo 降级 | set_value 静默 no-op 类 bad case |
| 3 | 键盘 PostMessage 中间级 | press_key/key 后台路径 + focused_descendant | 键盘链脱离"必激活" |
| 4 | Chromium 元素路径分流 | 工具层降级（元素中心坐标 + PostMessage 直投） | 元素左键单击遮挡假成功面 |
| 5 | scroll / drag 后台路径与节拍 | 两工具的矩阵断言族（E1 缺口补齐一并做；断言按本项目 fixture 契约维护，见 §5） | 矩阵 scroll/drag 族从零到有 |
| 6 | 后台并发：锁重设计 + E2E 并行实验 | per-root 队列实验 → 定案 → 落地 | Goal_2 的实验验证闭环 |

不做（本批边界）：launch_app/kill_app/set_window_frame/invoke_menu 的承接
决策（S2 映射账已列，单独批）；XUL 行为专门处理；UIAccess/提权通道。多 Helper 进程协调不立项：产品唯一入口是
desktop 主进程，Windows 上一机一 Helper（stable pipe 单例 + 复用拉起），
"多 session"是同进程内多路连接（CuaRuntimePool 隔离），不存在跨进程输入
交错面。

## 2. WM_CHAR 文本插入中间级（解锁 8 个锚点格）

现状：`type(strategy=event)` 元素目标在 win32 上恒走
`dispatchWindowsForegroundKeyed`（激活 + SendInput），矩阵 8 格
focusViolation 红（登记为 S4 锚点）。

插入路径使用 changed + contains 判据；读回失败保留 unverifiable，
不把 unchanged/unreadable 当成确定未发送。节拍初值为键间 4ms、WM_CHAR settle 40ms。

设计：

1. native 新增 `focusedDescendantForRoot(root)` 与
   `postMessageCharAsync(root, pid, text, pacing)` 原语。
   focused_descendant 用**纯 Win32 解析**（EnumChildWindows 收集根窗下
   GUI 线程 → GetGUIThreadInfo 取各线程 hwndFocus → 过滤出根窗真子孙，
   多个命中取最深；无命中回落根窗）（**2026-10-19 实施确认：本条原文误写为「UIA 查
   CurrentHasKeyboardFocus」，UIA 变体对后台窗口的有效性无先例且成本高，
   经确认改为 Win32 变体，与 §0/§10 统一**）。
2. broker：元素目标的 event 插入请求路由改为 PostMessage 级（矩阵分类
   kTextInput 列已就绪）；投递后按 changed+contains 读回（复用 #2 的
   readback 设施，插入判据）。前置（2026-10-19 实施确认补充）：工具层
   `type(strategy=event)+元素目标` 需把已解析的元素 native token 以
   additive 参数（`element_native`）随 `type_text_to_app` 传给 broker，
   供派发与读回共用；无 token（纯 app 打字）维持现有
   前台路径不变。
3. 验收：锚点格（**8 格全口径**——可转绿宿主 wpf/winui3/winforms/qt6 ×
   caret/selection 两用例，见 §1 修正）delivered + path=post_message + 零
   focusViolation；
   caret/selection 位置的 oracle 断言（mirror=Xcd / aXd）保持原期望。

## 3. type / set_value 读回裁决

- 写前读取 before，执行写入，再读取 after；ValuePattern 优先，TextPattern.DocumentRange 兜底。
- 替换路径要求 `after == requested`；原值已等于目标值的幂等写入也可 confirmed。
- 插入路径要求 changed + contains，原值已含目标文本但未改变不能算送达。
- verify 分 confirmed/pending/changed_contains/unchanged/unreadable；effect 独立记录。
  pending 表达延迟发布假说，suspected_noop 表达无效果怀疑，二者都不授予重放权限。
- 读回失败不抛新的写入错误；保留已发送事实并返回 unverifiable，提示重新观察。
- Chromium echo 降级放在读回层，type 与 set_value 都接入，不依赖投递前的分支顺序。

验收覆盖 type_replace、set_value_clear、set_value_same、deferred_single_publish，
包括 400ms 延迟发布场景；矩阵独立检查值、焦点、路径和重复输入。

## 4. 键盘 PostMessage 中间级（press_key / key）

键盘中间级投递目标为已验证根窗口的焦点子 HWND；分类判定丢弃时，
仅确定未发送且允许升级的分支进入前台级。前台级执行精确 HWND gate 与条件恢复。

设计：

1. native：`postMessageKeyAsync(root, pid, chord, mods)`——focused_descendant
   解析 + WM_KEYDOWN/UP 序列（修饰键按下 → 主键 → 释放，4ms 键间）。
2. broker `dispatchWindowsForegroundKeyed` 前置一级：win32 键盘请求先查
   键盘分类列——deliverable 走 PostMessage 级；dropped（含 XAML 键盘行）
   按 D1 自动升级前台（保留既有精确 HWND gate / 物理 lane；「条件恢复」
   当时并不存在——gate 只记录未消费，2026-10-20 按 E5/E7 真机观察项补齐，
   见总纲 §3.5 前台化条件式恢复条款）。
3. XAML 加速键：`strategy=auto` 的 hotkey 类请求查 UIA AcceleratorKey 匹配
   → Invoke（窄匹配才触发）。
4. 物理键盘（strategy=event / 全局工具）维持现状（物理 lane + SendInput）。
5. 验收：矩阵覆盖 hotkey、加速键场景及其真实控件 oracle；
   后台占比指标相应上移；`key_foreground_delivery` 显式
   event 格保持前台。

## 5. scroll / drag 后台路径与节拍（含 E1 断言补齐批 1）

### scroll

后台 scroll 的候选路径是 WM_VSCROLL/WM_HSCROLL + SB_LINE*/SB_PAGE*，
amount 表示消息条数；真实滚轮路径使用前台 SendInput。是否可达必须由宿主探针证明：

1. 先用 fixture 投递两类消息，记录真实 scroll_offset 与前后台姿态。
2. SB 码族只有在宿主显式消费时接入；滚轮消息无有效证据则移除该候选。
3. 不可投或分类 dropped 的宿主按 D1 进入前台级；element_index 保持 UIA ScrollPattern 首选。
4. 矩阵按必过、前台、不可用三档记录，横向滚动须有独立 oracle。

### drag

后台路径为 MOVE 预热 → DOWN → 驻留 35ms → 12×(MOVE + 25ms) → UP，
投起始点最深子 HWND；前台锁步注入后 settle 40ms。各路径独立验证。
WPF 的 GetKeyState 约束使后台拖拽按 dropped 处理，仅确定未发送时升级。
非客户区标题栏/边框拖拽的计划与实际落地差异，以总纲 §4.3 的 TODO 为准，不能视为已完成。
验收使用 slider_value、drag_status 状态机与拒绝码；时序诊断不能替代真实动作效果。

## 6. 后台并发：PostMessage 锁重设计 + E2E 并行实验

### 设计决策（实验先行，后落地）

**决策 A：拆分 `g_inputSequenceMutex`。**

理由：v3 让后台 PostMessage 脱离全局串行后，这把锁成了唯一的全局
冲突点（burst 级 try_lock → busy 拒绝）。而 burst 交错的实际危害面分析：

- **不同根窗口的两个 PostMessage burst 交错**：各自投各自的消息队列，
  控件状态机互不影响是本批待验证的并行假设，以 P1-P8 实验为准。
- **同一根窗口的两个 burst 交错**：DOWN/DOWN/UP/UP 交错会把双击拆成两
  次单击等语义破坏——**需要互斥**。
- **SendInput（全局注入流）与任何 burst**：SendInput 影响真实输入流，
  与 PostMessage 到同一前台窗口时可能交错——SendInput 侧已有物理 lane
  进程内串行，native 层保留 SendInput 与 PostMessage 间的互斥保守正确。

方案：

1. `g_inputSequenceMutex` 拆为：`g_sendInputMutex`（SendInput 侧全局，
   try_lock 保留——物理 lane 已保证进程内不并发，撞锁即异常路径；现持有
   者全名单：SendClickAt / ExecutePostMessageClick / Drag / KeyDownGlobal /
   KeyUpGlobal / PressChord / HoldKey，拆锁时逐一归位；scrollAt 持另一把
   g_inputStateMutex，不受本次拆锁影响）+
   per-root-HWND 队列表 `g_postBurstQueues`（同根窗口的 PostMessage burst
   **排队执行，从不拒绝**；不同窗口完全并行）。队列条目带归属 pid/exe
   复核，窗口销毁时清队。
2. 键盘/文本/滚动的 PostMessage 原语（§2/§4/§5 新增）接同一 per-root
   队列。

**决策 B：无跨 Helper 面——多 session 即同进程多连接。**
Goal_2 的"多 CUA session 并行"全部落在单 Helper 进程内（CuaRuntimePool 按
workspaceKey + sessionId 隔离状态，broker 输入路径共享）；P1-P8 的并行
实验覆盖的就是这个形态。CLI standalone 形态未发布，不存在第二入口；若
未来发布（自带 Helper 进程），届时该形态的输入交错属新增产品边界，
需重新评估，不在本计划假设内。

### E2E 并行实验设计（矩阵新增 parallel 节）

实验先于拆锁落地，用现有 busy 行为当对照组：

| 用例 | 形态 | 断言 |
| ---- | ---- | ---- |
| P1 双窗口并发后台点击 | 两 fixture，同 cell 内 Promise.all 两个 left_click | 双 delivered、双 path=post_message、无 busy 错误（拆锁后；拆锁前记录 busy 次数作对照） |
| P2 同窗口并发双击 ×2 | 同一 fixture，Promise.all 两个 double_click | counter 恰好 +2 且 last_action=double_click×2（无 DOWN/DOWN/UP/UP 拆单）；busy 期间排队不拒绝 |
| P3 PostMessage + 前台升级并发 | A 窗后台点击 + B 窗前台升级并发 | 双 delivered；焦点 watcher 见 B 激活事件仅限 B 窗口段 |
| P4 键盘后台 + 异窗口点击并发 | A 窗 WM_CHAR 打字 + B 窗后台点击 | 文本完整写入 A（无字符丢失）、点击 delivered |
| P5 双 paste 并发（进程内） | 同 Helper 两个 paste | 串行完成，无接管误判（pasteboard_changed_during_paste 不触发） |
| P6 同进程双 session 并行 | 同一 Helper，两个 session 各点各窗（CuaRuntimePool 隔离） | 双 delivered、零 busy（Goal_2 主路径的端到端见证） |
| P7 双窗口并发 UIA 元素点击 | 两 fixture，同 cell 内 Promise.all 两个元素目标 left_click（AX 阶梯路径） | 双 delivered、双 path=ax；pattern 调用不走门闩的并行性见证（v3 移出 single-flight 的回归锚） |
| P8 同窗口并发元素+坐标点击 | 同一 fixture，元素点击 + 坐标点击（坐标走 PostMessage）并发 | counter 恰好 +2；AX 与 PostMessage 两条通道交错无丢动作（per-root 队列只管 PostMessage burst，AX 不进队的正确性见证） |

runner 侧新增 `kind=parallel` 用例类型：一个用例 = 并发 dispatch + 汇合后
统一 oracle 判定 + 逐路径取证（复用 delivery 元数据）。P1-P8 全部进固定
集合（复核确认 runner 的 callTool 逐 case 回调结构支持并发派发后汇合
   断言）。八者都是单 Helper 进程内的场景，成本与普通格同级。

## 7. Chromium 元素路径分流

1. win32 直接 Chromium 宿主的普通左键单击（无修饰、auto）跳过 AX 动作梯，
   取已验证元素中心走 PostMessage 直投；内嵌宿主维持既有 UIA 路由。
2. 元素中心必须来自有效观察 bounds。失配或过期时拒绝并要求重观察，不投过期坐标。
3. delivery 记 `path=post_message`，attempts 带 `chromium_element_downgrade`；
   右键、多击、修饰键行为保持既有契约。

验收由 electron 遮挡窗口变体检查 counter、实际 path 与焦点事件，证据见本项目探针报告。

## 8. 接线与验收边界

14 工具参数契约保持不变；读回与 echo 降级必须在实际可达路径验证，
不能仅凭 schema 声明或不可达分支声称能力已接入。平台与宿主证据分别记录。

## 9. 阶段与验收

| 阶段 | 内容 | 出口 |
| ---- | ---- | ---- |
| S4.0 | 并行实验基建（kind=parallel runner + P1-P8）+ 拆锁前基线（busy 对照数据） | 实验报告落盘；P6 为 Goal_2 主路径见证（同进程双 session）；P7/P8 为 AX 通道并行性锚 |
| S4.1 | 拆锁（sendInput mutex + per-root 队列） | P1-P8 全绿，P2 无拆单 |
| S4.2 | WM_CHAR 插入中间级 + 读回裁决（§2/§3）——**已实施（2026-10-19）**：native 三原语（postMessageCharAsync / elementValueReadAsync / setValueReadbackAsync）+ focused_descendant Win32 解析（含 sentinel 取证形态下的元素宿主 HWND 回落）；工具层 element_native 透传；broker 替换读回与插入路由；分类器单测 39 项绿。**真机矩阵（4 宿主 × 2 锚点格）8/8 绿**：winforms/qt6 后台 post_message + changed_contains（qt6 当时的绿依赖 setup set_value 偷来的焦点，守卫修复后转登记边界，见 §14）；wpf/winui3 按 D1 前台升级（WPF 文本列与 XAML 键盘中间级经实测改标不可投，见 §12）。type/set_value 四族 oracle 全 delivered（mirror 精确值）；当时的 13 格 WPF Focus() 焦点违规为 S4.2 遗留，已于 2026-10-20 修复（§14：双层守卫 + 接缝接线 + 前台建焦前置，总纲 §6.1 账本条目随之移除） | 8 锚点格转绿；type/set_value 四族绿 |
| S4.3 | 键盘 PostMessage 中间级 + XAML 加速键（§4）——**已实施（2026-10-19，含真机矩阵验证）**：native 两原语（postMessageKeyAsync：修饰键按下→主键 KEYDOWN→4ms→KEYUP→逆序释放，focused_descendant 投递，含 alt 走 WM_SYSKEY*、lparam 带扫描码/扩展位；invokeAcceleratorAsync：UIA AcceleratorKey/Name 括号提示 canonical 匹配→Invoke→Toggle 链，miss=确定未执行）；broker `dispatchWindowsBackgroundKeyed` 前置路由（键盘分类列 deliverable 投递、dropped/XAML not_sent 升级前台=N6、possibly 类终止禁重放；strategy=event 跳过中间级直进 Windows 前台链）；winui3 fixture 自建 xaml_accelerator 场景（KeyboardAccelerator 声明式 + AcceleratorKey 注解式两格，scenarios.json 已标注 SELF-BUILT；AcceleratorKey 为纯 UIA 注解属性经 Microsoft keyboard-accelerators 文档查证）。矩阵新格：winforms/qt6 key_background_delivery（必过，path=post_message）、wpf accel_foreground_escalation（D1 升级，escalated=true）、winui3 xaml_accelerator_declared/annotated（必过，path=ax + reason=accelerator:invoked）；lib 必过清单与路径取证断言同步。路由单测 12 项 + native 契约 16 项绿。**真机矩阵（4 宿主）键盘族四类格全绿**：winforms/qt6 后台键击 path=post_message 零焦点违规；winui3 两加速键格 path=ax + accelerator:invoked；wpf accel 格 escalated=true + accel_fired=1；key_foreground_delivery 显式 event 格保持前台语义；backgroundRatio 47/75→53/75（键盘链后台占比上移）。矩阵绿的三件配套修正（commit 49acc21604）：runner appRef 随 bind 回执补 window_id（中间级以根 HWND 为锚，pid-only 目标使层不适用而静默回落前台）；WPF fixture AccelCmd 补状态文件发布（后台击发不触发 Activated 驱动的发布）+ lib 前缀表补 accel_fired=；winui3 declared 按钮补 AcceleratorKey 注解（KeyboardAccelerator 声明不自动暴露给 UIA）；wpf accel 格派发前借焦点哨兵压目标至后台（前序前台格激活残留会使前台条件化键盘列判 deliverable，升级链不触发，见 §13-3）。收尾轮的 13 格 suite 级 focus-violation 清单为 S4.2 遗留（当时误按账本既有口径归账），已于 2026-10-20 修复并改判，取证与修法见 §14 | 键盘族断言绿；后台占比上移 ✅ |
| S4.4 | scroll 可行性探针 → 按证据接入 / drag + E1 批 1 断言（§5）——**已实施（2026-10-20）**：**探针先行落盘**（[报告](./2026-10-19-scroll-postmessage-probe-report.md)，34 组合 × 5 宿主全程后台取证）：SB 码族仅 wpf/winui3 可达（宿主侧 hook 消费；winui3 必须投根窗，子窗 DesktopChildSiteBridge 忽略）；滚轮族（WM_MOUSEWHEEL）全败 → N1 按证据收缩不落地；winforms（AutoScroll 非客户区滚动条）/qt6（自绘）/gtk3 两族全忽略。探针顺带取证出 fixture oracle 通道缺口（wpf/winui3 的 lbl-scroll-offset 不进状态文件，已修）。**产品接入**：native `postMessageScrollAsync`（WM_VSCROLL/HSCROLL+SB_LINE* 投根窗，amount=消息条数，30ms 消息间隔）与 `postMessageDragAsync`（MOVE 预热→DOWN→35ms→12×(MOVE+25ms)→UP，起始点最深子 HWND）；前台 Drag 补 UP 后 40ms settle（修复 qt6 drag_move_count）；broker scroll/drag 中间级前置路由（分类列 dropped/结构性不可投宿主 not_sent 升级前台 D1；possibly 类终止禁重放；strategy=event 跳过；升级回执携带前序 not_sent attempts + escalated=true）。**E1 批 1 断言**（scroll_offset / slider_value oracle）：wpf/winui3 scroll_background_delivery（必过，path=post_message）、qt6 scroll_foreground_escalation（escalated=true）、qt6 slider_drag_background_delivery（必过，value 前进 + path=post_message 零升级）；lib 必过清单与路径取证断言同步。路由单测 16 项 + 受影响单测 530 项绿。**真机矩阵（baseline-2026-10-19T22-5x 轮）scroll/drag 族全绿**：wpf/winui3 后台 SB 码族 offset=48 零升级零焦点违规；qt6 升级格 offset=158 escalated=true；qt6 后台拖拽 slider_value=0→91 path=post_message；qt6 drag_move_count refused→ok（前台 40ms settle 生效）。**实测收缩登记（不硬凑）**：scroll_element_a11y 三宿主全撤（wpf 折叠线锚点无屏幕点 / winui3·qt6 SetScrollPercent 焦点副作用——UIA ScrollPattern 后台滚动语义未获证，见探针报告 §5）；winforms/gtk3 的 scroll 格与 wpf/winforms 的 slider 格受折叠线/无树几何约束（fixture 预滚动/重排后补格） | 探针报告落盘 ✅；scroll 族按探针三档登记 ✅；drag 族从零到有 ✅ |
| S4.5 | Chromium 元素分流（§7）+ 文档同步——**已实施（2026-10-20，含全量矩阵复核）**：实现落地于 8fb2686aa8（遮挡变体格 `click_counter_element_occluded` 多轮全绿，探针报告 §6）；S4.5 出口条件经 2026-10-20 全量矩阵两轮复核确认（delivered + path=post_message + chromium_element_downgrade 标记）。同批文档同步：矩阵规范 §10 账本（vitest 占位清除、xaml_popup/electron type 补格） | 遮挡变体格 delivered 且 path=post_message ✅ |

每阶段独立提交、独立可回退；矩阵固定集合只增不删，诊断/锚点账本口径
沿用 S3 规范。总纲 §4.2-4.4 与 §3.4 的 effect 分档随 S4.2 同步修订；
§4.3 drag 常量表、§4.4 scroll 路由按本文 §5 修正。

## 10. 风险与未验证项

- scroll 后台化整体可行性存疑（§5 警示）：本仓尚未验证后台滚轮
  消息路径，SB 码族也需要实测；S4.4 探针先行，探针全败则 scroll
  保持纯前台并如实登记。
- focused_descendant 是纯 Win32 解析（EnumChildWindows 收线程 +
  GetGUIThreadInfo 取 hwndFocus，非 UIA 查询），单次成本为微秒级系统调用；
  wait_for_focused_descendant 的轮询（含超时）才是时序敏感点——若矩阵
  显示键盘/文本用例因等焦点变慢，评估轮询间隔与超时值，不在本批预设。
- per-root 队列的窗口销毁竞态（队列等待中窗口关闭）：条目带身份复核，
  失效即放弃（not_sent），不重放。
- P6 依赖 runner 建立第二个 session 上下文（同 Helper 内）；若 session
  建立成本超预期，降级为直连 broker 的双连接形态，验证目标不变。

## 11. 本项目验证清单

每项按独立证据验收，失败则收缩并如实登记。

| # | 项 | 出处节 | 验证手段 |
| --- | --- | --- | --- |
| N1 | 后台滚轮消息 | §5 | 真实宿主探针，无消费则移除候选 |
| N2 | SB 码族可达性 | §5 | 区分显式 hook 与真实应用消费 |
| N3 | WM_CHAR 后台插入 | §2 | 8 个锚点格，检查 caret/selection 与 mirror |
| N4 | set_value 读回 | §3 | 替换、清空、同值、延迟发布四族 |
| N5 | echo 降级 | §3/§8 | Chromium type/set_value 的实际读回路径 |
| N6 | 键盘自动升级 | §4 | delivered + escalated；仅 not_sent 可升级 |
| N7 | Chromium 元素 bounds 新鲜度 | §7 | 遮挡变体与过期 frame 拒绝 |
| N8 | 物理动作排队 | §6 | P1-P8，后台动作不占物理 lane |
| N9 | per-root burst 队列 | §6 | 同窗防拆单与 AX/PostMessage 交错 |
| N10 | 并发 E2E | §6 | 每阶段固定 parallel 集合 |
| N11 | 同进程多 session | §6/§1 | P6 |
| N12 | 插入位置保真 | §2/E3 | 原 caret/selection oracle 不变 |

N3/N12 按总纲 §4.2 的插入契约验收；不能把追加文本成功当成插入位置正确。
N1/N2 的探针全败时保持前台路径并登记后台不可用。

## 12. S4.2 实施中的实测修正（2026-10-19 落地记录）

> S4.3 的实测修正另记 §13（同日期落地）。

真机矩阵取证推翻/细化了四项预判，均已按证据落地并同步总纲：

1. **select_text 的 collapse 实现 bug（历史遗留，本批修复）**：旧
   SelectText 只移动 End 端点（从文档头起算），实际选中 [0, start+length)
   而非折叠于 start——"设光标到 2"变成"选中 ab"，后续插入按替换错误选区
   处理（winforms/qt6 mirror 精确复现预测：abcd+caret@2+X → "Xcd"）。
   修复 = Start 端点同移（[start,start] 折叠）。这是锚点格"准备步骤"的
   根因，不修则锚点永红。
2. **WM_CHAR burst 不套 DisabledHwndGuard**：实测禁用状态下的窗口对投递键盘消息的消费不可靠（WPF 后台
   mirror 恒不变的首轮嫌疑之一）。移除后 NoActivateGuard 保留。
3. **取证 sentinel 的 AttachThreadInput 会清掉目标线程 hwndFocus**：
   FocusedDescendantForRoot 回落根窗 = 投给不消费 WM_CHAR 的窗口。修法：
   postMessageCharAsync 增加元素 ref 参数（第 4 参），focused 未命中时
   解析元素宿主 HWND（NativeWindowHandle + IsChild 归一）回落。这不是
   产品路径的妥协而是语义修正——type(event)+元素目标的插入语义本就
   锚定在该元素上。
4. **WPF 文本列 deliverable→dropped**（用户决策 2026-10-19）：WPF 控件
   无独立 HWND + InputManager 键盘焦点门控，后台不消费 WM_CHAR（本仓实测）；锚点格在 WPF 上按 D1 前台升级验收（与 XAML 宿主
   同口径，XAML 跳过按总纲 §3.6-3 落地为 broker 路由分支）。
5. **effect 证据的键盘类分流与读回接线**（2026-10-19 bench 修复，用户
   决策 ①+②+③轻量版）：bench 取证（inkscape-layers 14 次 / godot-input
   15 次 / pbi-kpi 16 次）表明 type 的树指纹 unchanged 在自绘/GTK/web
   画布宿主上全是噪声（打字实际已落地），且旧建议文案无条件教模型
   "dispatch once more"造成重复输入。修复三件：
   - type / key / paste 接 `effectKind: "keyboard_input"`，unchanged 建议
     改 verify-first（写明"树不反射 canvas/GTK/web 宿主的文本"，先验证
     落点、确认未落地才重发一次）——镜像 coordinate_pointer 的对症先例；
   - 携带 `delivery.readback` 的动作（type/set_value 元素路径）跳过树
     指纹结算（字段级读回是更精确证据；粗粒度 unchanged 在 Chromium
     echo 假 changed / Lark 型假 unchanged / 400ms 延迟发布窗口上是
     系统性噪声），下一次观察也不再寄存/结算指纹；
   - 回执附一句中性读回事实（五档各配文案，echo 降级与幂等有专门表述；
     不暴露内部路径名、不带重试参数）。
   旧 Helper（无 readback 字段）行为不变（回退指纹结算）。

## 13. S4.3 实施中的实测修正（2026-10-19 落地记录）

真机矩阵四轮迭代（2026-10-19，报告 baseline-2026-10-19T13-38-40-027Z）
取证出六项，均已按证据落地（commit ff04df8004 / 49acc21604）：

1. **矩阵 runner 的 app_ref 必须带 window_id**：键盘中间级与 S4.2 插入
   中间级一样以根 HWND 为锚——runner 旧形态只传 `{pid}`，broker 中间级
   判"层不适用"静默回落前台，键盘族四格首轮全部走前台路径（evidence：
   delivery=null 的 press_key_to_app 回执）。修法：bind 观察回执的
   `structured.window.window_id` 随 appRef 带下。这不是产品缺陷，是
   runner 的锚定前提缺漏。
2. **KeyboardAccelerator 声明不自动暴露给 UIA**：winui3 declared 格首轮
   `accelerator_missed`——声明式加速键只注册键盘处理，UIA 树上无广告可
   匹配（微软文档口径：AcceleratorKey 是应用侧自行声明的注解属性；真实
   XAML 应用也需显式提供该注解）。修法：declared 按钮同时声明注解（真实应用的推荐做法），
   两变体（声明式/纯注解）都走主匹配分支，场景描述同步。
3. **WPF accel 升级格需要反向哨兵姿态**：前序前台格的激活残留使 WPF
   目标恰处前台，前台条件化键盘列（§12-4 同款条件）判 deliverable → 投递成功但 GetKeyState 根因
   使 KeyBinding 必不消费（accel_fired=0，escalated=false）。修法（用户
   决策"占位窗口压后台"）：expectedEscalation 格派发前借焦点哨兵把目标
   压离前台——升级链自己完成激活，预备只保证请求以真实后台姿态进入。
   升级格不做后台焦点断言（激活是升级的固有部分，S4.2 既有口径）。
4. **WPF fixture 的 AccelCmd 不发布状态文件**：加速键击发只改 label，
   而状态文件的发布钩在 Activated 上——后台击发永不触发。oracle 通道
   断链使格永红。修法：CommandBinding 内直接 PublishFixtureState
   （与 winui3 加速键计数同款），lib 前缀表补 `accel_fired=`。
5. **原生模板约束（编译修）**：UiaDeadlineWorker 模板在作业收尾统一
   reset `job.element`——AccelInvokeJob 需带占位空 shared_ptr（加速键作业
   从 HWND 起扫、不持元素强引用）；WideToUtf8 只收 `const wchar_t*`。
6. **winui3 加速键 miss 后的升级链工作正常**：declared 格修复前的 miss
   轮里，D1 升级前台后 accel_decl_count=1（前台 SendInput 把加速键打中），
   证明 XAML 加速键 miss → not_sent → 前台升级的完整链路行为正确。

**验收口径的遗留事实**：目标恰在前台的 WPF 窗口收到默认策略组合键时，
本仓投 PostMessage 且加速键不生效（GetKeyState 约束）。该窗口态作为已知边界记录；矩阵用反向哨兵
姿态钉住升级链语义，不虚构"前台态投递也升级"的行为面。

**基线对照**：S4.3 收尾轮的 suite 级 focus-violation 清单
（type_replace/set_value_*/deferred_single_publish 族）与 S4.2 落地时的
上午基线报告逐格一致——非 S4.3 引入，账本归 §12-4/总纲 §6.1 既有口径。

## 14. set_value 焦点违规根因修复（2026-10-20 落地记录）

§13 末尾"账本归 §6.1 既有口径"的定性经复核**不成立**，本节按证据改判并修复。

**边界修正**：总纲 §6.1 曾把 WPF Focus() 抢前台登记为不可修边界。
本仓实际缺少双层守卫：NoActivateGuard/WS_EX_NOACTIVATE 保护 WPF 焦点链，
EnableWindow 保护 XAML/Chromium 显式自前台。两层职责互补，必须分别接线并验收。

**本仓两处实现缺口**（13 格 = type_replace/set_value_clear/set_value_same ×
wpf/winui3/winforms/qt6 + deferred_single_publish × wpf，S4.2 时代起逐轮
复现）：

1. `RunSetValueReadbackJob` 只套 DisabledHwndGuard（非 burst 模式仅
   XAML/Chromium 生效），缺盖 WPF 链的 NoActivateGuard；
2. `elementWindowId` 接缝声明在 AxReadOnlySource、Windows source
   （win.ts）从未接线，native 也无 `getWindowId` 导出——broker 的
   `?? 0` 回退使 host_root 恒 nullptr，连 DisabledHwndGuard 的既定
   覆盖面也整体空转。

**修复**（补齐双层守卫）：

- native `GetWindowId(ref)` 导出 + `ResolveHostRootFromElement` 共享助手
  （祖先 NativeWindowHandle → GA_ROOT；PatternCallJob 的内联 walk 同步
  去重）；
- win.ts / ax-types.ts 接 `elementWindowId` 接缝；
- `RunSetValueReadbackJob` 双层守卫（NoActivateGuard + DisabledHwndGuard），
  host_root 未传时沿祖先自解析兜底；
- 前台插入升级路径补**元素建焦前置**（窗口先激活、元素后聚焦、聚焦确认失败不发键）。

**耦合面（第一刀的必然后果，非回归）**：插入锚点格此前一直靠 setup 阶段
set_value 偷来的残留焦点才通过。守卫生效后失焦 no-op 显形：wpf/winui3 的
caret/selection 走前台但元素无框架焦点（4 格）；qt6 两格后台 WM_CHAR 送达
但框架焦点不在目标框。处置分两半：

- **前台升级路径（已修）**：在激活门 + 前台复核之后、SendInput 之前对目标
  元素显式建焦（窗口先激活、元素后聚焦、聚焦确认失败不发键）。首版曾把建焦放在
  激活门之前——对未激活窗口做 UIA SetFocus 落点不可靠（wpf selection 格
  实测 X 错投、mirror 不变），修正后 wpf/winui3 四格全绿（隔离轮与全序列
  轮双确认；16:31 全序列轮 selection 格的一次失败为轮次性，非代码缺陷）。
- **后台 deliverable 路径（qt6 两格，决策定案 2026-10-20：维持现状）**：
  根因 = set_value 不再偷焦点后，Qt 单 HWND 树的 focusWidget 不在目标框，
  WM_CHAR 送达但控件不接受（readback=unchanged，如实报 unverifiable）。
  被丢弃的修复提交曾用「unchanged → 像素点击建焦 + 重投」补偿，qt6 实测
  mirror=abcdX——点击把光标砸到末尾，caret/selection 插入点丢失；其配套
  解法是给 type 加 insert_range 参数重设插入点（已 reset，type 设计无此
  参数）。用户决策：两格按「后台插入在无框架焦点宿主上的已知边界」
  登记，红灯保留监督；后台路径不隐式建焦，不增加行为面。模型侧 unchanged 回执已带 verify-first 建议文案，不再补偿。

**矩阵验证**（baseline-2026-10-19T16-11-40Z / 16-31-53Z / 16-39-52Z /
16-40-32Z 四轮）：focusViolations 13→0；set_value/type_replace/deferred 族
四宿主全部 delivered + background + focus_events=0；插入锚点 wpf/winui3/
winforms 六格全绿（mirror 精确 abXcd/aXd）；qt6 两格为已登记的已知失焦
no-op 边界（上述决策）。总纲 §6.1 账本条目随修复移除（账本自身规则：
修复后条目必须移除、门禁口径自动收紧）。
