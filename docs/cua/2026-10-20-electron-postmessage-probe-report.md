# Windows 输入派发：electron 直接 Chromium 宿主 PostMessage 可达性探针报告

> 状态：已完成取证（2026-10-20）。计划：[S4 实施计划 §7](./2026-10-19-windows-input-s4-plan.md)。
> 探针脚本：`packages/zcode-cua/scripts/windows-electron-postmessage-probe.mjs`。
> 原始证据：`test/fixtures/reports/electron-postmessage-probe-2026-10-20T02-27-01.json`
>（3 姿态 × 3 重复，journal oracle + 焦点取证）。

## 1. 目的与方法

本批验证 Chromium 元素左键单击通过元素中心 PostMessage 直投的可达性。
本仓旧取证（2026-10-17，commit 61c51031ee，四轮基线）显示坐标点击
`post_message:sent` 但 counter 无变化。需要在当前原语形态下重新取证，
才能决定是否调整直接 Chromium 的矩阵门。

方法论对齐 scroll 探针（S4 计划 §5）：不先写产品路径，用**当前完整形态的
产品原语**（`postMessageClickAsync`：deepest-child 解析 + NoActivateGuard +
burst DisabledHwndGuard + 35ms 驻留节拍 + per-root 队列）在真实链路上重新
取证。链路：dist helper（dev pipe）+ broker + `ax_native.node` 直调原语；
fixture 为 `harness-electron`（`--force-renderer-accessibility`）；oracle 走
journal（DOM MutationObserver → loopback POST，独立于 UIA/CDP 读回通道）。

三姿态（每姿态 3 次重复，btn-increment 元素中心屏幕坐标）：

| 姿态 | 预备 | 验证的问题 |
| ---- | ---- | ---------- |
| bg   | 焦点哨兵压前台，checkpoint 复核目标非前台 | 后台可达性（目标场景） |
| occl | 哨兵压台 + 无边框置顶窗（240×160）叠住按钮区域 | 遮挡下可达（验收变体格的场景） |
| fg   | 目标窗口自身在前台（对照组） | 排除"投递本身坏了"的解释 |

## 2. 结论总表

| 姿态 | 消费（counter +1） | 原语 ok | 焦点事件 |
| ---- | ------------------ | ------- | -------- |
| bg   | 3/3                | 3/3     | 1（目标 pid，首击，见 §4） |
| occl | 3/3                | 3/3     | 0        |
| fg   | 3/3                | 3/3     | 0        |

**裁决：electron（直接 Chromium 宿主）上 PostMessage 左键单击后台可达，
遮挡下可达。** 元素中心直投路径按计划落地，无需收缩。

## 3. 与 10-17 noop 取证的关系（推翻声明）

10-17 四轮 noop（61c51031ee 时点）**不再代表当前行为**。当时的原语形态与
当前的差异（git 考古）：`DisabledHwndGuard` 的 posted_burst 全宿主启用是
10-18 修 focusViolation 时引入（此前 burst 期间 WebView 宿主事件处理器可
SetForegroundWindow 自激活/自扰）；per-root 队列与节拍常量收口
（kInputPacing）是 10-19 拆锁时引入。本轮探针在当前 HEAD（40dbe6d0d9 线）
上 9/9 消费，证据以新轮次为准——矩阵门对"直接 Chromium 投递必丢"的判定
由此证伪，元素分流路径绕过该门（分流先于矩阵判定），坐标路径的矩阵门维持不动（坐标路径的行为另行回归验证）。

## 4. Chromium 异步自激活残差（焦点契约的真实情况）

真机矩阵取证（2026-10-20，多轮稳定复现）：electron 直接宿主在**未遮挡**
后台姿态下，首个 PostMessage 元素点击会伴随 1 条目标 pid 焦点事件——
Chromium/Electron 的异步 click handler 显式调 `SetForegroundWindow(self)`，
`WS_EX_NOACTIVATE` 挡不住显式自前台，且消息消费可晚于投递几十毫秒，EnableWindow
shield 同样只护到投递函数返回。遮挡姿态（TopMost 窗口压住按钮区域）下
激活被 Windows 前台锁拒绝，零事件。

**处置（用户决策 2026-10-20）**：
`ExecutePostMessageClick`（ax_win.cc）在 settle 末尾做条件矫正——三条件
全满足（原前台存在、非目标自身、此刻前台已被目标抢走）才用
AttachThreadInput 借前台锁 token 两连投恢复原前台（12ms 间隔）。即**事后恢复，不预防**：抢台瞬变事件本身无法避免。

**矩阵验收口径（登记式豁免）**：electron 的 post_message 路径格，焦点
事件 ≤1 条且终态非目标（恢复成功）视为行为正确；事件多于 1 条或终态仍
被目标占据照旧判违规。

**如实登记的已知残差（红灯保留）**：press_gated / hover_gated 两格终态
仍被目标占据（恢复失败）——门控控件在点击后还要跑 ≥15ms 计时器，消费
晚于 50ms settle 的单点检测窗口，单点恢复盖不住。有界轮询形态（100ms×6
检测窗口）实测可覆盖该时序，但会使遮挡格事件形态不稳定（一轮出事件），
已按用户决策回退，不以轮询换稳定格。

## 5. 对实现的输入

1. 触发面（用户裁决）：仅直接 Chromium 顶层宿主
   （`Chrome_WidgetWin_` / `CefBrowser` 前缀；Electron 命中）；
   内嵌宿主（WebView2/Tauri，`has_chromium_descendant`）**不**分流，
   维持 UIA 阶梯。
2. 计划验收行"webview 遮挡格"按范本修正：webview 元素格维持 path=ax，
   遮挡变体格挂在 electron。
3. 投前校验（N7 增量）按计划 §7-2 落地。

## 6. 最终验收结果（2026-10-20 真机矩阵）

- **遮挡变体格 `click_counter_element_occluded`（本批验收目标）**：稳定
  全绿——delivered + `path=post_message` + attempts 带
  `chromium_element_downgrade` 标记 + 零焦点违规（baseline-
  2026-10-20T02-56-43 / 02-58-15 / 03-29-22 多轮）；
- **普通元素格 `click_counter_element`**：delivered + post_message 路径，
  1 条焦点事件 + 终态恢复 → 按登记式豁免通过；
- **press_gated / hover_gated**：delivered + post_message 路径，但终态仍被
  目标占据（§4 残差）→ 如实红灯保留监督；
- 其余格（坐标/双击/右键族）行为与改动前一致。
