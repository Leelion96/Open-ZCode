# Windows 输入派发 S3：实现契约与当前验证

> 状态：**SUPERSEDED（2026-10-18 v3 极简重构）**。本计划的租约模型（§2）、
> 全屏 hit-test 主级（§3.2）、拒绝式 6 格（§8.4/§8.5）已被
> [总纲 v3](./2026-10-13-windows-input-delivery-spec.md) 废除：
> 租约→物理 lane（排队不拒绝）、hit-test 收敛为单级窗口域枚举、
> 6 格预登记拒绝→自动升级。§5 节拍、§4 shield/超时边界、§3.3 强引用桥仍有效。
> 以下原文保留作历史参考，不再作为实现契约。
>
> 隶属：[Windows 输入派发总纲](./2026-10-13-windows-input-delivery-spec.md) §3、§4.1、§5.2、§6。
> 测试契约：[Windows harness 矩阵规范](./2026-10-13-windows-harness-fixture-matrix.md)。
> 第三方许可归属：trycua/cua，`libs/cua-driver/rust/crates/platform-windows`（MIT）。
>
> 总纲是母规约；本次同步修订总纲与矩阵，不保留“本文优先”的例外。正文保留实施契约，当前验证结果见 §7。

## 0. 范围与决定

S2 的 key 别名、provided paste、list_apps 已完成；当前点击实现与验证状态见 §7。
S3 实现派发地基与 left_click 全链路。14 工具签名保持不变；S4 的文本、滚动、
拖拽、键盘路由不在本阶段重做，但其现有前台操作必须接入同一派发准入门。

- 策略与升级链在 broker 的 windowsInputDispatch.ts；native 只提供原语。
- broker 对一次输入请求持有唯一派发租约；native 的 g_inputSequenceMutex 只保护
  投递 burst，不能替代激活、异步等待、恢复前台之间的互斥。
- 先验证 WGC 位图的实际边界与坐标映射，再决定是否切换 DWM；截图、投影、
  窗口观察和实时 probe 必须同源，不能把 PrintWindow 裁剪结论直接套到 WGC。
- 丢弃矩阵只决定是否跳过 PostMessage，不决定 UIA 是否适用。
- XAML/UWP/WinUI3 的普通单击走后台 UIA，并在实际动作调用线程内挂
  EnableWindow shield；不因宿主类别预先激活窗口。超时不等于 COM 取消或 shield 已恢复。
- delivery 只进入 broker 元数据；模型文本通过 receiptText 剥离该字段。
- 先写测试并记录红灯，再实现；诊断用例、必过用例和已知缺陷分别登记，oracle 不改口径。

### 0.1 本项目派发契约

XAML 后台元素按四模式梯尝试，保留 Legacy 兼容末级；shield 归一到 GA_ROOT，
保存原 enabled 状态，由实际动作线程恢复。坐标动作超时不提前释放资源或重放。
Chromium 普通左键单击优先走 PostMessage 特例，其他适用点击先尝试 UIA，
丢弃矩阵只判断后续 PostMessage 路径。unknown 按 deliverable 尝试。

14 工具签名冻结；确定未发送且允许升级时才进入前台 SendInput。合成 pen/touch
注入层暂缓。线程适配、派发互斥、DWM 同源与强引用服务于本项目运行时。

## 1. 派发状态机

下图的“UIA 级 / PostMessage 级 / 前台级”对应总纲 §3.1 的第 2 / 3 / 4 级，
不把预检序号混入执行级编号。

```text
click / element_perform_action(AXPress)
  → 同步取得 broker 派发租约；busy 则拒绝，不能先激活窗口
  → 检查 native 是否仍有超时未结束的 UIA 作业；有则 busy，不切前台
  → 绑定精确 HWND + pid/exe + frame 几何；失效/cloaked/iconic 则 refused
  → UIPI 预检；blocked 则 refused，禁止切前台绕过
  → 选择路由
      strategy=event 或有修饰键 → 前台级
      已确认不支持的后台手势 → 明确未发送拒绝（§8.4、§8.5）
      WinUI3 元素左键双击 → 同一作业内两次 Invoke
      Chromium 左键单次无修饰 → 宿主特例；必丢分类不投消息
      Chromium 其他形状 → 按实际宿主分类与支持边界路由
      左/中键单次无修饰（含 XAML/UWP/WinUI3）→ UIA 级
          （仅 (left||middle) && count==1）
          XAML 宿主：动作线程内 EnableWindow shield，不激活目标
          元素：Invoke → Toggle → Select → Expand → Legacy（仅四模式均 absent）
          坐标：ElementFromPoint + 祖先 HWND 归属 → 窗口域枚举
          只有 Miss / 模式确实不支持，且未发送 → 查丢弃矩阵
      右键/多击（无修饰） → 查丢弃矩阵，不走 UIA
  → 查丢弃矩阵
      droppable → 记录 PostMessage not_sent → 前台级
      deliverable / unknown → PostMessage 级
  → 每级 sent / possibly_sent：终止，禁止重放
     not_sent：仅允许升级的分支且身份/权限仍有效才可进入下一级
  → 在同一 broker 租约内完成条件恢复，再释放租约
```

WPF/GTK 的 PostMessage 必丢不能跳过其适用的 UIA。Chromium 单击是明确的路由
特例，含元素中心坐标；修饰键必须走可表达真实键状态的前台级，不能交给不带
modifiers 参数的 PostMessage 原语。显式 event 跳过后台级，仍走新节拍、
精确窗口 gate、租约与恢复，不继续调用旧的无节拍 ClickAtPoint。

元素梯只有四个模式全部明确 pattern_absent 才尝试 Legacy；查询报错、token 失效、
权限失败不等于模式不存在。动作 COM 调用一旦开始，失败也按 possibly_sent 终止。
四模式均 absent 且 Legacy absent 时，保留 action_unavailable + action_sent=false
与工具层现有 fallthrough 的衔接。该 fallthrough 目前会强制 event，不能把它统计成
后台升级；两次 broker 调用的原始证据都要保留。

## 2. 唯一派发所有权与精确窗口 gate

### 2.1 broker 租约

租约由 Helper 内的同一 broker 输入上下文持有，不按 HWND 分锁，因为前台与真实
键鼠状态是桌面级资源。准入在第一次 await 前同步完成，冲突直接 busy，不建等待队列。

所有可能激活、恢复前台或改变真实键鼠状态的 handler 都接入此门，包括 click、
元素 AXPress、现有 key/type/paste、drag/hold 和其显式 event 分支。组合动作只在
外层取得一次租约，内部函数传递所属操作，不递归申请。不得只加强 click 而让
旧键盘路径仍能在其 hover 或修饰键等待期间激活另一窗口。

```text
A：取得租约 → 身份/权限检查 → 精确 HWND gate → worker 发送/settle → 条件恢复 → 释放
B：            请求到达 → busy；没有激活、输入或恢复副作用
用户切前台：                             → 发送前复核失败；停止余下输入，不抢回前台
```

native UIA single-flight 是实际作业是否结束的事实源。超时响应不清空它；broker
可以结束本次响应并释放 JS 租约，但下一次输入必须先检查 native pending 状态。
旧作业真正返回前，新的输入一律 busy；事件循环与非 UIA 查询仍可用，不承诺卡死
provider 的 UIA 观察可用。late completion 只清理自己的
作业代次，不回写已返回回执，不触发重放或恢复其他请求的前台。

### 2.2 前台级

不能把 dispatchWindowsForegroundKeyed 的 PID gate 原样提取成窗口 gate：

1. 在持有租约且通过身份/UIPI、no-focus 策略、active-hold 检查后，记录原前台
   HWND 与进程身份。
2. 判断 GetForegroundWindow 的根 HWND 是否等于 expected_window_id；同 PID 的
   另一个窗口不能视为已命中。不同则调用已有精确窗口激活原语。
3. 复核目标 HWND、pid/exe、frame 几何与前台根 HWND，全部匹配才提交输入 worker。
4. worker 取得 g_inputSequenceMutex 后、每次有间隔的 burst 实际发送前，重新复核
   同一目标身份与前台 HWND。首次发送前失效记 not_sent；发送后失效记 possibly_sent，
   只释放本作业已按下的键/按钮，不继续点击，不升级重放。
5. finally 中仅当当前前台仍是本作业激活的目标、原窗口身份仍有效，才 best-effort
   恢复。用户已切到第三个窗口时不恢复。restoreForegroundAsync 只接受当前租约与
   预期当前 HWND，不提供无条件 SetForegroundWindow 通道。

S3 接线时只修改所需 gate 与调用点，不重做 S4 工具的具体输入语义。

XAML 元素目标按 §1 在后台复用已绑定 token 与单 rung UIA，不要求元素 bounds；
不能为了 shield 的超时风险先激活窗口再执行 AX。坐标目标仍遵守像素命中与 owner
校验，不能用任意元素调用替代用户选择的坐标语义。

## 3. 坐标与元素归属

### 3.1 窗口截图与点击坐标对齐

当前 capture、window 与实时 probe 共用 win_window_geometry.cc/.h 的
ReadWindowFrameBounds，优先读取 DWMWA_EXTENDED_FRAME_BOUNDS；DWM 查询失败时
同次解析回退 GetWindowRect，并如实标记 geometry_source。帧和点击共享解析结果，
来源不一致或几何变化即拒绝并要求重观察，不放宽 0.5px 比较容差。

| 消费者                                       | 当前约束                                              |
| -------------------------------------------- | ----------------------------------------------------- |
| screen_capture_win.cc / ValidateWindowTarget | expectedBounds、捕获前后矩形与 screenshot_bounds 同源 |
| ax_win.cc / BuildWindowFromHwnd              | window.bounds 使用共享 frame helper                   |
| ax_win.cc / ScreenCaptureProbeWindows        | probe 使用同一矩形与来源                              |
| broker 帧校验与帧记录                        | 记录 geometry_source，拒绝来源或几何变化              |

frame-projection.ts 保持纯投影；WGC 不裁剪时不增加 inset。GetWindowRect 在面积选窗等
独立用途可保留。Helper 重启后旧 frame_id 失效。PostMessage 的 ScreenToClient 是
独立的客户区换算，每层均从原始屏幕点转换，并验证 deepest-child 归属。

PrintWindow 裁剪不能直接套用到 WGC；同源约束须由本项目链路验证。
当前点击矩阵与 GTK3 中途缩放回归已通过，但不能替代完整多屏/DPI、负坐标、自绘边框
及 DWM 查询失败路径的真机验证。这些覆盖边界列于 §7，不再以旧探针样本计作本提交验收。

测量工具 windows-frame-geometry-measure.mjs 的复核契约保持不变：实际屏幕公共边界
生成跨屏目标；捕获前后核对窗口/DWM/客户区/DPI/样式/拓扑；用边缘与内部标记的真实
点击事件验证落点；不稳定样本不得准入，原始 PNG、协议及源码/二进制摘要保持 gitignored。

### 3.2 确认控件属于目标窗口（无 HWND 元素）

HWND 是 Windows 窗口句柄，owner 在这里指“这个控件属于哪个目标窗口”。
UIA 控件不一定各自拥有 HWND，例如一个窗口内绘制的按钮仍可有 UIA 节点。

本计划保留了全屏 ElementFromPoint 主级，需要独立证明命中控件属于目标窗口。
祖先 HWND 解析只服务于该主级；从目标 ElementFromHandle(hwnd) 枚举的次级
已限定候选窗口范围。

主级不能直接假设 ElementFromPoint 返回的元素有 NativeWindowHandle。
该属性可能为 0，见 [Microsoft 属性契约](<https://learn.microsoft.com/en-us/previous-versions/dd319225(v=vs.85)>)。

从命中元素沿 RawViewWalker 祖先向上查找最近的非零 HWND，再经 GA_ROOT 与已验证的
expected_window_id 比较。遍历带节点上限、同一作业 deadline 和 cancelled 检查；
不得跨用全屏命中的遮挡者 HWND，更不能用元素 ProcessId 对比 app_ref pid。
找到 HWND 后仍要验证其 live 根窗口身份。

主级候选同样使用坐标无关控件白名单、bounds 含点与 Invoke/Expand 能力约束；
同具两模式时优先 Expand。无归属证明或命中遮挡者，只放弃候选，转目标窗口域枚举。
次级按最小面积选择合法候选；CoreWindow 空壳树按 Miss 处理，不遍历桌面兄弟树。
真实 UIA 查询错误按 unavailable 拒绝，不能伪装成 Miss。
XAML 通过 owner 校验后仍走后台 UIA；shield 只防止动作处理器自抢前台，
不是把宿主转前台的准入策略。

### 3.3 让异步点击持有的元素引用保持有效

registry 是“元素 token → 原生 UIA 对象”的登记表；COM 的 AddRef/Release 表示
持有/释放一次对象引用。这里处理的是工作线程使用对象期间，它不能被重观察提前释放。

本仓 `ax_win.cc` 的 `g_elementRegistry` 无锁，`LookupElement` 返回 borrowed
指针，`RegisterElement` 更新条目会 Release 旧对象；现有代码以主线程同步访问为前提。
S3 把动作放入 AsyncWorker 后，需用主线程查表并保留强引用，防止重观察释放
worker 正在使用的对象。这是异步化后的存活契约，不代表已复现同步路径崩溃。

```text
动作开始：主线程查 token → AddRef → worker 使用对象 → 真正完成后 Release
重观察：                         更新登记表，释放表中的旧引用
结果：worker 自己持有引用，对象不会因登记表更新而提前销毁
```

现有 g_elementRegistry 只能由 V8 主线程访问。新增 WinAxElementFromToken 的契约是：
在 NAPI 入口主线程查表并 AddRef，返回作业独占的强引用；不得把 LookupElement 的
borrowed 指针交给 worker，不得从 worker 读写该 unordered_map。

每个实际调用 UIA 的线程自己 CoInitializeEx(COINIT_MULTITHREADED)，使用私有
CUIAutomation；S_FALSE 正常配对清理，RPC_E_CHANGED_MODE 按 unavailable 拒绝，
不能容忍后继续执行。现有主线程是 MTA；保留元素强引用时必须验证这一前提，
不跨 STA 直接传裸指针。新增观察 worker 或改变 apartment 需另行维护跨线程契约。

single-flight 的嵌套线程拥有自己的 COM 初始化、factory、元素强引用与堆上作业状态，
均在实际调用结束后释放。外层 AsyncWorker 超时返回不提前 Release；嵌套线程不持有
Napi::Env，不访问已结束的 worker，不在 Helper teardown 后回调 JS。
这样可保留主线程观察，不必把整张 registry 改成跨线程共享 map。

## 4. 超时与防抢前台的边界

UIA 作业采用 single-flight + deadline：
调用前检查 cancelled，4s 到期返回 timeout/possibly_sent；门闩直到真实调用结束才释放。
busy、timeout、unavailable 分别保留，均不触发当前调用的升级重放。

EnableWindow shield 的生命周期契约：

- make_guard 仅对 is_xaml_host_hwnd 或 is_chromium_target_window 命中的宿主启用；
  向 GA_ROOT 归一，保存原 enabled 状态，禁用后执行 UIA 动作，在同一线程析构恢复。
  不用无条件 EnableWindow(true)，避免把原来就禁用的窗口错误启用。
- guard 与元素强引用由实际调用线程持有，不跨 FFI 暴露 begin/end，不交给超时等待者
  提前清理。每次动作前检查 cancelled；取消发生在调用前则不再发送动作，正常析构。
- Chromium 普通左键单击走 PostMessage 特例，不进入 UIA；该路由不能推导出
  XAML 也应跳过 UIA。其他宿主仍先尝试适用 UIA，再按矩阵决定是否跳过 PostMessage。
- NoActivateGuard 用于投递 burst，不将其套到已显式激活的前台 SendInput，
  不声称它能阻止任意显式 SetForegroundWindow；结束后按原前台身份条件恢复。
- WPF 已归档 Focus() 边界继续如实记录，不因采用 shield 扩张豁免。
  S4 的 UIA 动作复用同一 shield 机制，不另建按框架预先前台化的路径。

必须如实保留超时边界：若调用已进入 provider，4s 超时只结束等待，不析构仍阻塞的
动作线程。门闩保持占用，原窗口可能保持 disabled，直到调用返回才恢复；
不能承诺“超时即恢复”，也不能通过自动转前台或重放来规避。
用可控 provider 验证超时、晚返回、原 enabled 状态恢复和无重复动作；
永久阻塞与 Helper 异常退出时的恢复能力另留运行时证据，尚未证明就写未验证，
不得以“RAII 总会执行”给出安全背书，也不将推测直接固化为新派发策略。
本批不新增 UIAccess 或独立 UIA 进程。

## 5. 点击节拍修复（独立任务）

本项修复“事件已发送，但控件没有按预期处理”的时序问题，与坐标落点修复分开验收。
当前 `ax_win.cc` 的 `SendClickAt` 对 down/up 连续发送，多击之间没有显式间隔；
源码能证明没有等待，实际控件是否 no-op 仍以各 fixture 的 oracle 为准。

PostMessage 与前台 SendInput 分别验证，不能把一个路径的等待常量直接套到所有点击。

| 路径           | 本项要实现的节拍                                                                                                          | 验收                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| PostMessage    | `WM_MOUSEMOVE` 预热 → DOWN → 驻留 35ms → UP；多击间隔 80ms；第二击按 `CS_DBLCLKS` 投 `WM_*BUTTONDBLCLK`；结束 settle 50ms | 实际 path=post_message；控件收到 move-before-down、press_duration_ms≥15；双击不能只记两次 click |
| 前台 SendInput | SetCursorPos 先就位；有修饰键时按下后等 5ms；每击用 [move,down,up] 单批；多击间隔 80ms；释放修饰键后 settle 120ms         | 修饰键在点击时可见；多击和普通点击生效；结束无本作业残留按键；恢复前台发生在 settle 后          |
| UIA 模式       | 不添加鼠标驻留或合成 hover；语义动作不产生对应鼠标事件                                                                    | effect/路径如实，无失败后重放；鼠标门控属于诊断集合                                             |

前台路径不增加单独的固定 hover sleep；沿用光标就位与已有节拍，不虚构新的等待值。
前台 [move,down,up] 单批仍是零驻留，不能承诺通过 15ms 按压门控。
PostMessage 35ms 是发送间隔，不等于已证明控件接收间隔；以 oracle 验收。
DOWN 前失败为 not_sent；DOWN 已入队后失败为 possibly_sent，尽力补齐释放，禁止升级重放。

kInputPacing 在 native 收口，与后续 drag pacing 同处；等待位于 AsyncWorker，不能阻塞
JS 事件循环。UT 核对事件顺序、常量与释放路径，真机按 §8 的独立路径用例见证。
鼠标动作开始后失败，不因节拍修复再次发送点击；身份、租约、前台复核仍遵守 §1-2。
本项需单独记录红灯与转绿证据，不能仅以“新派发链已接通”代替验收。

## 6. native 原语与回执

实际可能阻塞的点击/UIA 原语使用 Promise/AsyncWorker；COM 初始化与 DPI 上下文位于
真正执行调用的线程。分类、状态与引用桥是短同步操作，不伪称为异步导出。

| 实际接口/实现                               | 契约                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| classifyPostMessageDelivery                 | HWND + event kind，返回 dropped/deliverable 与 host；未知宿主可尝试                             |
| UipiBlockedForTarget（native 内部）         | 发送前校验完整性；不能借前台激活绕过拒绝                                                        |
| readWindowsInputDispatchState               | 只读 uiaJobInFlight/completedUiaJobs；未结束作业阻止新输入                                      |
| winAxElementFromToken / winAxElementRelease | 调用方强引用桥；真实异步作业另持独立引用                                                        |
| hitTestInvokeAtPointAsync                   | 验证身份与坐标、两级查询及 owner；实际动作包 shield；4s 等待不释放真实作业                      |
| elementPatternCallAsync                     | 单 rung 查询/调用；区分 absent、未发送拒绝、invoked、possibly_sent；invoke_double 只服务 WinUI3 |
| postMessageClickAsync                       | 验证 HWND/PID 与 deepest-child、逐层换算、i16 范围；持输入锁及完整 burst/settle shield          |
| clickAtPointAsync                           | 验证目标、精确前台及几何；同步定位光标、每击单批发送；失败仅清理自己的按下状态                  |
| broker 条件恢复                             | 同一派发租约内验证当前前台与恢复目标，用户切到第三窗时不抢回                                    |

节拍与常量的唯一实施说明见 §5。存量同步 ClickAtPoint 导出不改，
新 Windows click 接线使用异步原语，显式 event 同样执行本项节拍。

delivery 结构为 { path, effect, attempts[], escalated }，effect 为 confirmed /
unverifiable / suspected_noop / refused；类型可保留 partial，但 Windows 不产出。
每个 attempt 记录 path、dispatch_status、原因；可归因前台事件的执行阶段同时记录
同源单调时钟的起止值。失败也须保留已有 attempts，不能仅成功 result 带元数据。
原始错误不能经工具层 stringify 泄漏 delivery。

receiptText 在模型文本入口剥离 delivery；元素点击改道后，pointer.ts 不再固定追加
“semantic AXPress / no coordinate hit-test”说明，改为中性元素点击说明；如已切前台
最多一句如实披露，不输出路径 JSON。保持既有 action_sent / possibly_sent
语义，不把 effect=unverifiable 当成 action_sent=false。矩阵识别 ax、
post_message、foreground_send_input，失败从错误详情取 attempts；S4 未改路径保留已核实的
legacy_trace。元素 fallthrough 的多次调用保留完整证据，不伪装成一次原生事务。
矩阵按实际 ax / post_message / foreground_send_input 路径及 attempts 归因；
XAML 后台 UIA 不记 escalated。显式 event 仍是前台 SendInput，不因目标有元素
token 改回 UIA。
运行时逐级取证使用 debug 日志。

## 7. 当前提交的验证与剩余项（2026-10-18）

本节是当前实现的验证摘要。旧提交的失败快照、阶段漂移与修复过程不再作为当前状态。
本次文档整理不改产品、runner 或 fixture，不重新解释原始 oracle，也不改写历史报告。

### 7.1 点击专项

固定点击集合 **53/53 通过**：47 格生效、6 格明确未发送拒绝，点击集合无焦点违规，
runner 退出码为 0。拒绝格同时验证 reason=background_unavailable、action_sent=false、
全部 attempts 为 not_sent、独立业务状态不变；支持范围见 §8.4、§8.5。

| 宿主         | 通过格数 | 其中明确拒绝 | 未覆盖             |
| ------------ | -------- | ------------ | ------------------ |
| WPF          | 5/5      | 0            | 无                 |
| WinForms     | 8/8      | 0            | 无                 |
| WinUI3       | 12/12    | 4            | 无                 |
| WebView2     | 7/7      | 2            | 无                 |
| Electron     | 5/5      | 0            | 无                 |
| Qt6          | 8/8      | 0            | 无                 |
| Windows GTK3 | 3/3      | 0            | 元素单击、元素右击 |
| Tauri        | 5/5      | 0            | 无                 |

WinForms/Qt6 的 PostMessage 驻留、hover 和双击均有路径回执与控件事件证据。
WinUI3 普通单击覆盖 Invoke、Toggle、Select、Expand；语义双 Invoke 证明计数精确增加 2，
不宣称产生原生 DoubleTapped。GTK3 的坐标由实际布局投影，不伪造 AX 控件或 token。

### 7.2 原始报告与证据归属

当前点击实现的八宿主报告与工具原始证据保存在
packages/zcode-cua/test/fixtures/reports/：

- baseline-2026-10-18T03-04-31-108Z-78712b3515.json（S3 出口时点）
- evidence-2026-10-18T03-04-31-108Z-78712b3515.ndjson
- baseline-2026-10-18T10-48-52-244Z-7d81a5cc08.json（2026-10-18 矩阵整顿后）
- evidence-2026-10-18T10-48-52-244Z-7d81a5cc08.ndjson
- review-2026-10-18/：候选补丁、源文件哈希、新测试和检查日志。

报告是在代码提交前采集的；文件名及 commit 字段记录采集时父提交，实际被测产品、
runner 与 fixture 对应当前提交。该标识保留为原始证据，不改名为 amend 后的 SHA；
文档 amend 不代表重新执行过 E2E。

**矩阵整顿后（7d81a5cc08 时点）原始 117 动作**：72 delivered、27 noop、9 refused、
9 unresolved、0 unknown；noopRate=0.273、后台占比 56/99。27 项 noop 全部有登记
归属：**19 项诊断**（UIA 元素 press/hover 门控 12 + 前台单批零驻留 7，机制预登记，
非独立 bug）+ **8 项 S4 插入锚点**（caret/selection 插入用例改为 strategy=event
请求插入语义，目标交付是总纲 §4.2-4 的 PostMessage WM_CHAR 中间级，落地前如实
红）；**意外 noop=0**，诊断契约违例=0。文本路径焦点违规（21 项）是 WPF Focus()
已归档缺陷与 S4 前台插入通道的既有形态，另见 §7.4。53 格点击专项与原始全动作
使用不同分母，不能把点击专项通过等同于原始全矩阵或完整 S3 出口通过。

**S3 出口时点（78712b3515）的原始 119 动作**（历史保留，其中 8 项文本 noop 的
成因是矩阵请求误用替换通道——插入期望配了默认 auto/a11y 策略，属测试契约
错误而非产品缺陷，已于 2026-10-18 修正）：71 delivered、26 noop、9 refused、
13 unresolved、0 unknown；noopRate=0.268、后台占比 64/97。13 项 unresolved 中
2 项是 GTK3 元素路径格（探针取证后删除），其余为 GTK3 元素定位与 wpf 全量跑
快照漂移。

### 7.3 代码检查与真实回归

| 验证                                 | 当前结果                           |
| ------------------------------------ | ---------------------------------- |
| 受影响单测                           | 99 文件；1023 通过、4 跳过、0 失败 |
| 真实 native 回归                     | 4/4 通过                           |
| 类型检查、producer 构建、native 构建 | 通过                               |
| lint                                 | 0 错误、222 条既有警告             |
| 文档格式、相对链接与 diff 空白检查   | 通过（本次仅复核文档）             |
| 架构检查                             | 15 项 CUA 模块未登记违规，阻断     |
| 基线新鲜度                           | 远端连接失败，未完成               |

真实 native 回归覆盖 WPF/WinUI3 超时后 busy、晚返回与引用归还、真实完成后 shield
恢复、JS 可响应、同 PID 兄弟根窗拒绝、错误 shield 宿主/PID 拒绝、无重复业务动作，
另有 WinUI3 四模式控件与 GTK3 十轮激活点击及中途缩放。

三个真实测试文件位于 packages/zcode-cua/test/native/：
win-uia-timeout-lifecycle-cua.test.ts、win-uia-patterns-cua.test.ts、win-gtk-click-cua.test.ts。

复跑时先按矩阵规范构建 fixture、native 与 producer，再串行执行以下命令；
ZCODE_CUA_HARNESS_E2E=1 是真实测试的显式开关：

```powershell
$env:ZCODE_CUA_HARNESS_E2E = '1'
corepack pnpm --filter @zcode/zcode-cua exec vitest run test/native/win-uia-timeout-lifecycle-cua.test.ts test/native/win-uia-patterns-cua.test.ts test/native/win-gtk-click-cua.test.ts --maxWorkers 1
node packages/zcode-cua/scripts/windows-harness-matrix-baseline.mjs
```

### 7.4 剩余问题与未验证项

- 文本路径的 21 项焦点违规与原始 noop 尚需继续排查；点击专项没有将这些失败改为成功。
  其中 8 项插入 noop 已定性为 S4 锚点（矩阵请求契约错误已于 2026-10-18 修正为
  strategy=event + 后台 post_message 预期，见矩阵规范 §1/§6.2），不作为独立产品缺陷。
- Windows GTK3 元素单击、元素右击两格经探针取证（UIA 仅系统 TitleBar、MSAA 无子
  对象、WM_GETOBJECT=0、MSYS2 无 atk-bridge/gail 模块）确认结构性不可用，已从
  固定集合删除（矩阵规范 §4.1/§6.2）；坐标单击、双击、右击与节拍坐标格照常必过。
  WPF 夹具 below-fold 与焦点驱动滚动漂移已修（2026-10-18），wpf 套件双击/右击/
  hover 坐标格转绿。
- wpf 全量跑（多宿主串行）时 text_setup 曾命中陈旧 native token（role Custom 拒绝），
  单宿主复跑不复发——产品侧快照/token 生命周期问题，登记待 S4 文本链一并核查。
- 真实高完整性 UIPI、完整多屏/DPI 边界、用户在多击间隙切换前台、provider 永久阻塞
  及 Helper 异常退出后的恢复仍未验证。受控晚返回和同 PID 兄弟窗证据不替代这些场景。
- 架构登记与基线新鲜度门禁仍有阻断。当前为候选提交，不作发布验收；没有新增豁免、
  重置 baseline 或绕过 hook。

## 8. 测试与阶段出口

### 8.1 离线测试

- 注入可控暂停点，使 A 在节拍等待时 B 请求切前台；断言 B busy 且从未激活。
  同进程两 HWND 必须激活正确窗口；native 获锁后前台变化必须在发送前拒绝。
- token 强引用在主线程取得；重观察替换 registry 不释放作业持有引用；
  timeout 后仅真实完成时释放，late completion 不修改已返回回执。
- NativeWindowHandle=0 时沿祖先找到目标 HWND；遮挡者、无祖先、过期身份均不能 Invoke。
- 分类表逐格测试；WPF/GTK 必丢只跳 PostMessage，不能跳 UIA；unknown 不直接拒绝。
- XAML 普通元素单击走后台 UIA，无 bounds 也不改道坐标；动作线程启用 shield，
  返回或抛错时恢复原 enabled 状态，path=ax、escalated=false，未激活窗口。
  超时后门闩/guard 不被等待者清理，晚返回才恢复；原本 disabled 的窗口仍保持禁用。
  wedge provider 后新输入 busy，事件循环与非 UIA 查询可用，无升级重放。
- attempts 顺序、所有 sent/possibly_sent 终止分支、错误元数据、receiptText、
  kInputPacing、旧 addon 缺能力时的诚实拒绝、frame 投影与完整 probe 链路。

### 8.2 真机路径见证

显式 strategy=event 的 press-gated/hover 坐标用例只验证前台路径，不能作为 PostMessage
证据。WinUI3 元素双击按 §8.4 走语义双 Invoke，其他宿主按实际回执归因。

新增独立用例 ID：post_message_press_gated_coordinate、
post_message_hover_coordinate、post_message_double_click_coordinate。
通过同一产品链路的 coordinate + auto 请求进入候选后台路径；用不可 UIA 激活的
绘制区域作为 dwell/hover 控件，oracle 只统计鼠标事件，仍由 scenarios.json 定义。
双击用坐标目标而非会强制 event 的元素目标。

用例必须断言 delivery.path=post_message、attempts 没有先执行 UIA 动作、未升级，
并由 oracle 确认 dwell≥15ms、move-before-down、double_click。路由选错即失败，
不能仅凭最终控件状态通过。对 PostMessage 必丢或没有已验证投递路径的宿主，
登记该路径不适用的机制与替代前台功能用例；不能声称八框架均覆盖了投递级。
真实运行发现 API 投递节拍不等于控件接收节拍时，以 oracle 为准，不放宽阈值。

另补同 PID 多窗口、并发前台输入、边缘坐标与实时 probe、遮挡窗口、无 HWND 控件、
身份失效、UIPI 拒绝且不激活、XAML 后台 UIA + shield 的零抢前台，以及前台升级后
用户切前台不抢回的真机证据。
必须记录每个执行阶段时间，区分后台自抢与合法前台升级。

### 8.3 必过集合与诊断集合

- 必过集合：普通点击、坐标/身份/权限保护、适用宿主的 PostMessage 节拍、
  前台点击功能、并发隔离、恢复规则、回执与路径证据。
- 诊断集合：UIA 元素 press/hover 门控、保留零驻留契约的前台 press 门控。
  oracle 不满足仍为 status=fail + observedBehavior=noop，另用断言证明
  effect=unverifiable、无重放、路径如实；不能把业务失败改写成通过。
  同一用例若实际改道 PostMessage，就进入对应路径的必过集合，不再豁免。
- 诊断集合按机制和实际路径事先登记，不按回归结果临时调整。其焦点违规、错目标、
  重放或元数据错误仍阻断；只有所列指针时序不适用的 oracle 失败不阻断。
- 已归档缺陷单列，总纲 §6.1 当前仅 WPF Focus()。其余失败、unknown 或
  必过用例 unresolved 阻断 S3；已有框架暴露缺口保留为未完成项，不宣称覆盖通过。

总纲 §6 同步采用上述出口。全量原始 noop/pass 与诊断数量照常报告；
在固定的必过集合上 noop 率不升、pass 率不降。旧报告保持原样，仅用登记清单作
可追溯的同集合比较。（历史：78712b3515 时点后台占比 64/97，单列 XAML 后台送达与焦点违规；）
不能靠重分组宣称后台比例提升。S3 新增点击路径必须由 broker_metadata 见证，
全矩阵取证覆盖率维持 1.0，尚属 S4 的路径允许已核实的 legacy_trace。

### 8.4 WinUI3 支持边界（2026-10-18 确认）

- 后台坐标双击、右键和中键不投递消息，不自动升级前台；返回
  `action_unavailable`，`reason=background_unavailable`、`action_sent=false`。
  显式 `strategy=event` 仍使用现有前台路径。
- 已缓存元素的左键双击只对 WinUI3 Invoke 控件使用两次 Invoke，间隔 40ms；
  同一真实作业、强引用、single-flight 和窗口 shield 覆盖完整序列。
  这是语义双 Invoke，不承诺产生原生 DoubleTapped，也不适用于文本选词。
- 任一次 Invoke 开始后失败或超时都是 possibly_sent，禁止改道或重放；
  非 WinUI3 在未执行前返回 absent，保持其他宿主既有路由；WinUI3 无 Invoke
  能力时返回 background_unavailable，不能再转 Toggle 或自动前台重试。
- 矩阵把 WinUI3 原坐标 PostMessage 双击格改为明确拒绝格；左右键拒绝格必须同时
  证明 broker 未发送、业务状态未改变、无焦点事件。两次 Invoke 单列语义断言，
  不以 fixture 把两次 Click 合并为 double_click 的标签冒充原生事件证据。

### 8.5 其他宿主边界（2026-10-18 确认）

- 经真实回归仍无可靠后台输入路径的手势，沿用明确未发送拒绝，不自动前台重试。
  WPF 内嵌 WebView2 的后台右键适用此规则；Tauri 右键经完整消息 shield 已验证
  可送达且无焦点事件，保留后台路径。
- Windows GTK3 的元素定位依赖未具备的可访问性桥，本次明确未覆盖；不计入通过数。
  坐标单击、双击、右键仍须真实执行。坐标由夹具实际布局归一到窗口外框，
  再投影到当前截图；该测试定位不能伪造产品 AX 控件或 token。
- PostMessage 原语全程禁用根窗以阻止框架 SetFocus 自激活，结束恢复原 enabled
  状态。UIA shield 的宿主门控不变。只在恢复完成后释放作业与派发租约。

### 8.6 入口与批次回归

- 普通 AXPress 的 Windows 预检必须允许原生模式梯自行探测能力；只声明
  AXToggle、AXSelect、AXExpand 或仅 Legacy 的控件不能被 AXPress 名字提前拦截。
  仅模式不存在才推进；已调用后的失败或超时停止，不重放。
- 每次前台点击先同步定位系统光标，再以单次 SendInput 提交 move/down/up；多击每次都重新定位，
  防止批次间混入输入或沿用用户已移动的光标位置。部分发送只补按钮释放，
  不补点击；释放失败保留 owned-input ledger。
- GTK 测试几何随 configure/size-allocate 事件刷新；状态文件和原生窗口可捕获
  是独立就绪条件。真实回归包括十次激活点击和中途缩放，不靠固定延时更新状态。
