# S4.4 scroll 后台可行性探针报告

> 状态：已完成取证（2026-10-19）。计划：[S4 计划 §5-1](./2026-10-19-windows-input-s4-plan.md)。
> 探针脚本：`packages/zcode-cua/scripts/windows-scroll-postmessage-probe.ps1`。
> 原始证据：`test/fixtures/reports/scroll-probe-2026-10-19T17-45-53Z.json`（34 组合 ×
> 5 宿主，全程 `backgroundHeld=true` 取证）。

## 1. 目的与方法

S4 计划 §5 要求分别验证后台滚轮消息与 SB 码族的真实可达性。
已有 fixture hook 不能证明真实应用会消费这些消息，接入前必须先做探针取证。

方法论复用 S3 gtk3 探针：受控 fixture + 状态文件 oracle（`scroll_offset=N`）
+ 逐组合记录投递前后 offset 差值。每轮投递前把探针 console 置前台并校验
`GetForegroundWindow ≠ 目标根窗`（前台姿态下重试 8 次，全部组合 bg=true），
保证结论是**后台可达性**而不是前台行为。

组合矩阵：5 宿主（wpf / winui3 / winforms / qt6 / gtk3）× 7 组合：

| 组合 | 目标 HWND | 消息 |
| ---- | --------- | ---- |
| root_vsb_line / root_vsb_page | 根窗 | WM_VSCROLL + SB_LINEDOWN×3 / SB_PAGEDOWN×1 |
| child_vsb_line | 视口中心最深子窗 | WM_VSCROLL + SB_LINEDOWN×3 |
| sbar_vsb_line | 类名 `ScrollBar` 的子窗控件 | 同上（宿主不存在则 no_target） |
| vsty_vsb_line | 带 WS_VSCROLL 样式位的窗口（含根） | 同上 |
| root_wheel / child_wheel | 根窗 / 最深子窗 | WM_MOUSEWHEEL（delta=-120×3，lParam=中心屏幕坐标） |

## 2. 结论总表

| 宿主 | SB 码族 → 根窗 | SB 码族 → 子窗 | 滚轮族 | 判定 |
| ---- | -------------- | -------------- | ------ | ---- |
| wpf | **消费**（line 3→48、page 1→96） | 消费（同根窗，单 HWND） | 忽略 | SB 码族后台可达 |
| winui3 | **消费**（line 3→48、page 1→100） | 忽略（投给 DesktopChildSiteBridge 无效） | 忽略 | SB 码族后台可达（仅根窗目标） |
| winforms | 忽略 | 忽略 | 忽略 | 后台滚动不可达（见 §3） |
| qt6 | 忽略 | 忽略 | 忽略 | 后台滚动不可达 |
| gtk3 | 忽略 | 忽略 | 忽略 | 后台滚动不可达 |

（数值为 scroll_offset 差值；wpf hook 的 LINE=16px、PAGE=96px，winui3 hook
的 LINE=16px、PAGE=100px——3×16=48、1×96/100 与消费语义吻合。）

## 3. 关键发现

1. **SB 码族对"显式处理 WM_VSCROLL 的宿主"后台可达**：wpf/winui3 的消费
   依赖 fixture 侧 hook（WPF `HwndSource.AddHook` / winui3 `SetWindowSubclass`
   把 WM_VSCROLL 翻译进 ScrollViewer.ChangeView）。真实 WPF 应用须显式处理
   WM_VSCROLL 才消费它，投给不处理的窗口等于忽略。产品接入：**SB 码族投
   根窗**，可达面 = 宿主侧显式处理者。
2. **winui3 子窗目标结构性无效**：winui3 的 UI 内容活在
   `DesktopChildSiteBridge` 子 HWND 上，WM_VSCROLL 投根窗经 subclass 翻译
   可达、投子窗被忽略——**目标必须是根窗**（与 wpf 单 HWND 形成对照）。
3. **滚轮族全败（N1 收缩）**：5 宿主 × 2 目标全忽略。S4 计划 §11-N1 的
   后台滚轮消息尝试项**按证据收缩**——不落地产品路径，scroll 后台面 =
   SB 码族。
4. **winforms/qt6/gtk3 的 SB 码族也不可达**：WinForms AutoScroll 用非客户
   区滚动条（WS_VSCROLL 样式位，vsty 组合证伪了"投样式窗口即达"）；
   qt6/gtk3 自绘滚动不吃 Win32 滚动条消息。三宿主 scroll 维持前台
   （物理 lane + SendInput 滚轮），矩阵如实登记。
5. **fixture oracle 通道缺口（已修）**：wpf/winui3 的 `lbl-scroll-offset`
   此前不进状态文件（只在 UIA 树 label 上、滚动事件不触发发布）——无
   helper 的探针与矩阵的状态文件通道都读不到。已对齐 winforms/qt6 形态
   （标签更新处同步发布 + 初始值进状态字典），fixture 已重编。

## 4. 接入决策（按证据三档）

| 档 | 宿主 | 路由 |
| -- | ---- | ---- |
| 接入（SB 码族投根窗） | wpf / winui3 | broker scroll 中间级：deliverable → WM_VSCROLL/HSCROLL×amount（amount=消息条数） |
| 结构性不可用 | winforms / qt6 / gtk3 | not_sent → D1 自动升级前台（物理 lane SendInput 滚轮） |
| 矩阵必丢 | Chromium 直接宿主 / 内嵌 | 分类矩阵滚轮列已标 dropped → 升级前台（既有口径） |

- `element_index` 目标维持既有 `element_scroll`（UIA ScrollPattern）首选，
  中间级只是坐标 raw 路由的后台化（auto 兜底顺序不变）。
- 横向滚动：探针无横向 oracle 控件，矩阵断言阶段给 fixture 补横向能力后
  验证（SB_LINELEFT/RIGHT 与垂直同族，预期同判定；登记为待验证项而非结论）。

## 5. 接入后的矩阵轮次补录（2026-10-20）

产品接入与 E1 批 1 断言落地后的真机取证（baseline-2026-10-19T22-42 /
22-50 / 22-54 轮），按"实测收缩登记"原则补录三项：

1. **qt6 的 a11y 滚动带焦点副作用**：`scroll_element_a11y` 在 qt6 上
   SetScrollPercent 路径 focus_events=1（UIA 滚动偷焦点）。
2. **winui3 的 a11y 滚动同样带焦点副作用**（22-55-14Z 全量轮）：
   focus_events=2——UIA ScrollPattern 的后台滚动语义在 winui3 亦不成立。
3. **wpf 的 a11y 滚动锚点无有效屏幕点**（同轮）：`scrolltarget` Group 在
   折叠线下 bounds 超出屏幕，工具层 resolveTarget 拒绝（"target did not
   resolve to a screen point"）。
   综上：**scroll_element_a11y 三宿主全撤**——UIA ScrollPattern 的后台
   滚动语义在现有 fixture 宿主上未获证（几何或焦点两道约束），待按宿主
   逐个取证后再补格；坐标路由的后台化（scroll_background_delivery）不受
   影响（SB 码族不依赖元素屏幕点）。
4. **折叠线几何约束**：wpf/winforms 的 scroll 容器与 slider 在外层滚动
   内容的折叠线下（bounds y 值超出栅格域，光栅投影不可达）——两宿主的
   对应格本批不承载（fixture 预滚动/重排后补格），不硬凑。
5. **bind 观察不带图**：runner 的坐标端点计算需带图快照的 `image_size`
   （bind 观察无该字段）——slider 拖拽格改为自包含的带图快照投影
   （端点 = 元素 bounds 5%/90% 处）。
