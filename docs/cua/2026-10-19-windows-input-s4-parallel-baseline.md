# S4.0 并行实验基建与拆锁前基线（2026-10-19）

> 状态：已执行。对应 S4 计划 §6 / §9 S4.0 行（kind=parallel runner + P1-P8 +
> 拆锁前 busy 对照数据）。runner：
> `packages/zcode-cua/scripts/windows-harness-parallel-experiments.mjs`
> （单测 `test/matrix/parallel-lib.test.ts`，opt-in `ZCODE_CUA_HARNESS_E2E=1`，
> 定向 `ZCODE_CUA_PARALLEL_FILTER=P1,P3`）。

## 基线结论（三连跑稳定复现）

| 用例 | stage | gating | 结果 | 说明 |
| ---- | ----- | ------ | ---- | ---- |
| P1 双窗口并发后台右击 | S4.1 | 否 | pass | 双 delivered、双 path=post_message、零焦点违规 |
| P2 同窗口并发双击 ×2 | S4.1 | 否 | pass | clicks 恰好 +2、无双击拆单、无 busy 拒绝 |
| P3 后台 PostMessage + 前台升级并发 | S4.1 | 否 | pass | 双送达；后台臂零焦点事件 |
| P4 WM_CHAR 打字 + 异窗点击并发 | S4.2 | 否 | FAIL（text_not_landed）| 预期红：type(event) 当前只有前台路径，S4.2 中间级落地后转绿（锚点） |
| P5 双 paste 并发（进程内） | now | 是 | pass | 串行完成、双读取确认、无 pasteboard_changed_during_paste 误判 |
| P6 同 Helper 双 session 并行元素点击 | now | 是 | pass | Goal_2 主路径端到端见证（双 ax delivered、零 busy） |
| P7 双窗口并发 UIA 元素点击（单 session 双臂） | now | 是 | pass | pattern 调用不走门闩的并行性锚（v3 移出 single-flight 的回归见证） |
| P8 同窗口并发元素（AX）+坐标（PostMessage）点击 | S4.1 | 否 | pass | counter/clicks 各恰好 +1，双通道交错无丢动作 |

**busyTotal = 0（全部用例、全部轮次）**。

## 对 S4.1 拆锁的实证修正

计划 §6 的"burst 级 try_lock → busy 拒绝是对照组"预期没有成立：三轮全量
（含同窗口双击对撞）零 busy。机理：

- `ExecutePostMessageClick` 跑在 `PostMessageClickWorker`（Napi AsyncWorker
  线程池），两臂天然并行进入临界区；
- 单次 burst 总时长 ~300ms（35ms 驻留 ×2 + 80ms 间隔 + settle），两臂几乎
  同刻发起点时才可能撞锁；实测调度抖动足以错开。

含义（写进 S4.1 设计输入，不改变拆锁方向）：

1. 拆锁（g_sendInputMutex + per-root 队列）的收益从"消除高频 busy 拒绝"
   修正为"消除剩余的偶发撞锁面 + 语义正确性（同窗 burst 交错防护）"——
   P2 的无双击拆单在撞锁侥幸错开下也成立，per-root 队列把它从"靠调度
   运气"变成"结构保证"。
2. g_inputSequenceMutex 的 try_lock 语义（撞锁即拒）在 PostMessage 层
   从未在测试中被观察到触发——拆除它不构成行为回退风险的实证补强。

## 取证基建（本轮交付）

- runner 复用矩阵链路（startHelper/attachMcpSession/callTool/spawnHarness
  从 baseline 导出，单一事实源）；
- 双 MCP session（P6 形态 = 常态基建）：并发臂各持独立 client，broker trace
  按 session 隔离，delivery 归因无交叉；
- focus watcher 复用：后台臂 posture（哨兵前台）+ attempt 窗口内目标 pid
  事件即违规；attemptStart 收窄到并发派发段（arms 工厂是准备段，曾因包含
  工厂期窗口把夹具自身显示激活误判为 P1 违规，两轮假红后修正）；
- helper stderr 结构化诊断（paste_provided*）进证据 sidecar——P5 类超时的
  唯一运行时取证通道；
- winforms 夹具新增 `CUA_E2E_WINDOW_X/Y` 位置偏移：双实例固定 (4,4) 完全
  重叠时 z-order 顶层窗消费彼此的坐标点击（P1 取证证伪重叠形态），第二
  实例按 680px 偏移；矩阵基线不传该变量，行为不变。

## 排障记录（两个真根因，均已修在 runner/fixture 侧）

1. **P5 顺序依赖（P3→P5 稳定复现 fail）**：P3 的 event 左击把 B 窗
   ActiveControl 定在按钮上；WinForms 后台窗口的 `Control.Focus()` 不更新
   ActiveControl（前台焦点事件驱动），P5 的后台 PostMessage 聚焦无法覆盖；
   paste gate 重新激活 B 窗时恢复旧 ActiveControl，ctrl+v 落进按钮
   （reads=0 / paste_count=0）。修正：P5 前置聚焦改 strategy=event 真实
   前台左击——paste 本身就是前台升级语义，前置聚焦同为前台动作与被测
   行为一致。这不是产品缺陷：真实链路里 paste 前的聚焦同样是前台动作。
2. **带图观察偶发缺图（image_size=null）**：coordinate_setup 的
   include_screenshot 观察偶发不携带帧（观察层已知边界族），坐标解析
   直接落 null → 工具参数校验炸。修正：coordinateForPid 对齐矩阵的两段
   重试 + bind 帧回退。
