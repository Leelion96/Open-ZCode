# Conversation Product Projection 当前实现

更新日期：2026-10-29

`ConversationProductProjection` 是 CLI 面向 App/Web 的会话读模型。产品语义以
[conversation-product-protocol.md](../conversation-product-protocol.md) 为准，wire schema 以
`packages/shared/src/zcode-protocol-v4/` 为准；本文说明当前代码如何从 runtime 事实生成并恢复该投影。

## 权威链路

```text
runtime SessionEvent / persisted transcript
  -> event-normalizer.ts             统一 live/cold 的 canonical fact
  -> ProductProjection               归约 control/config/queue/rows 等产品态
  -> ConversationTopicPublisher      生成 snapshot/delta、seq、logEpoch
  -> Host connection scope           只做订阅 ownership 与 frame 转发
  -> ConversationProjectionStore     原子 apply，不重新解释业务事件
  -> SessionPane                     按 rows 与显式 availability 渲染
```

当前实现入口：

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/event-normalizer.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
- `packages/ui/src/v4/conversationProjectionStore.ts`
- `packages/ui/src/v4/sessionDataLayer.ts`

## 投影拥有的状态

snapshot 的 A 区显式承载：

- `control`：phase、stop 状态、active works、最近错误与 API retry；
- `availability`：fork、compact、模型/模式切换、queue 操作、goal 操作是否可用；
- `inputRouting`：`startNow | enqueue | guide | reject | choice`；
- `meta`、`config`、`usage`；
- `queue`、`pendingInteractions`、`pendingCommands`、`backgroundWorks`；
- `goal`、`plan`；
- `rows` 与窗口信息。

UI 不得再从消息数组、最后一条消息、tool 状态或本地 task runtime 推导这些字段。renderer 只拥有
draft、焦点、滚动、布局以及按 `commandId` 关联的临时 optimistic overlay。

## 五种 delta

增量集合是封闭的：

```text
row.appended { row }
row.upserted { row }
row.removed  { fromRowId }
row.delta    { rowId, path, append }
state.updated { patch }
```

`state.updated` 对键整体替换，禁止深合并；`row.removed` 从指定 rowId 起截断。无法由这五种操作
无歧义表达的结构变化必须触发 snapshot/resync，不能在客户端新增修补算法。

每个用户输入、timeline marker 或 child-session 事实尽量保留 `sourceCommandId`。它是命令去重、
ACK 丢失后的 `commands/query` 以及 optimistic overlay 收口的共同锚点。

## Live 与 cold 恢复

CLI 事件日志是进程内有界日志，不是跨重启的持久化事实。正常运行时，publisher 从 live canonical
events 增量推进 projection；CLI 重启或首次冷订阅时，`transcript-hydration.ts` 从持久化的
message/part、timeline part、session input ledger 与 session metadata 合成等价事件，再交回同一个
normalizer/projection。

因此当前保证是“同一份持久事实恢复到相同产品终态”，不是“任意历史 revision 都可回溯”。如果
live 日志只覆盖部分 transcript，gateway 会按 footprint 检查选择完整 hydration/merge，禁止在 UI
旁路渲染数据库消息。

## 命令 actions 的物化时机

行上的 `actions`（`canEdit` 及其 `editDisposition`、`canRetry`、`canFork`、`canRewindFiles`）由
`materializeCommandRowActions` 生成：每个 live 事件归约后，对“当前快照 + 本事件 delta”整窗计算，
变化的行以 `row.upserted` 一并发出，并同步更新命令层使用的当前可编辑目标。edit/retry/fork target
的侧表由 reducer 登记，不在这里生成。strict replay 逐事件走同一规则；cold batch hydration 期间不逐
事件物化，只在结束时收敛一次。

例外：事件是对已打开流式行的追加，且本事件归约结果只有 `row.delta` 或为空，跳过物化。归约结果为空
的情况有三种：文件工具预览被节流；文件工具在节流窗口外，但累积内容与本次 delta 都为空；工具输入已
定稿后迟到的原始流。“已打开流式行的追加”与 publisher
快路径用同一个判据 `establishedStreamingAppend(event) !== null`，即 running 或 prewarming 状态下，
已打开 text/reasoning 行的 delta 和已登记工具行的 input delta。这类追加若同时带出其他增量（例如清除
`apiRetry` 的 `state.updated`、subagent 增量），照常物化。

- 等价理由：物化读取 prospective 行的种类、状态、轮次、userInput 的 `origin`、rowId 顺序与现有
  `actions`，turnHeader 的 `fileChanges.state`，`control.activeWorks` 与快照顶层的 `pendingInteractions`，以及
  messageId / entityId / edit target / turnHeader 四张侧表；输出行 `actions` 并更新当前可编辑目标。
  `row.delta` 只追加文本字段，流式追加路径也不写这些侧表，所以物化结果必为空、可编辑目标不变。
- 前提：事件到达前 actions 已与当前状态一致。现在由三点保证：其他 live 事件都会物化；cold batch
  结束时收敛一次；事件之外的写入方（`seed*`、`setRuntimeInitialization`）都不改写上述输入。
- 原因：此前每个 token 都整窗物化，长会话流式输出时每个事件的 CLI 成本随历史线性增长。以下数字来自
  Node 合成回放（每轮 3 行，临时脚本未入库，只作量级参考），`ProductProjection.applyEvent` 处理一个
  text_delta：3000 行 473µs → 16µs，8100 行 1319µs → 36µs，24000 行 4924µs → 166µs。剩余成本基本是
  不可变 apply 复制 `rows.window`（同规模约 21 / 39 / 152µs），属于 snapshot 表示的线性成本，不在本规则
  范围内。
- 约束：新增只产生 `row.delta` 的 reducer 若同时改写上述任一输入，必须让它不满足这个判据；在事件之外
  改写这些输入的写入方必须自己物化。否则 actions 会停在旧值。
- 回归：`apps/zcode-cli/packages/bootstrap/tests/product-projection-streaming-actions.test.ts`。
  逐事件断言哪些事件不调用物化，以锁定判据；同时与总是物化的参考投影比较 delta、snapshot 与 edit
  target，防止输出回归。参考比较能抓到“只产 `row.delta` 却改写侧表”而让 `canEdit` 或历史轮 `canFork`
  变化的回归；运行中的轮次里 `canRetry`、`canRewindFiles` 和本轮 `canFork` 本来就关闭，参考比较分辨
  不出判据宽窄，这一点由调用断言锁定。

## 订阅与投递边界

- desktop 使用 `desktop-continuous`：保留在线流式 `row.delta`；
- mobile remote 使用 `web-remote-replayable`：依赖 snapshot/gap 恢复，可过滤不可重放的中间 delta；
- profile 可以改变中间帧，不能改变 command、row 终态或最终 projection；
- 每个 connection/subscription 独立维护 ownership、seq、logEpoch 与恢复代际；
- Host、desktop main 与 relay 不保存 projection，也不建立第二个 reducer。

## 长会话窗口

schema 已定义 rows window 与旧行范围读取语义。客户端必须以 snapshot 提供的窗口为准，不能假定每个
snapshot 永远包含完整历史。当前 UI 对超长历史的完整 `loadOlder` 交互仍属于待补能力；在其落地前，
这是一项明确限制，而不是由客户端扫描 legacy message 补齐的理由。
