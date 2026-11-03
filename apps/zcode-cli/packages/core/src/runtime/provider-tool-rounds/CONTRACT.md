# provider-tool-rounds

服务端执行的内置工具（GLM 的 `analyze_image`、`webReader` 等）会让一次模型响应包含多轮。
本模块负责按服务端工具把响应切成轮次、给界面发工具卡片、按流顺序落盘，并生成回放 entries。
规格见 `apps/zcode-cli/docs/design/v2/model/anthropic-stream-compat.md`「Provider 内置工具多轮回放」。

```text
runModelTextRequest：tool_call(providerExecuted) → 收起当前 reasoning/text 为一轮
                     → persistProviderToolRoundContent（reasoning/text part）
                     → startProviderToolCard（Scheduled → Started）
                     provider_tool_result → finishProviderToolCard（tool part + Result）
提交（成功 / 取消）：createProviderToolRoundEntries → 每轮 assistant(text, tool_use) + tool(result)，排在最后一轮之前
冷恢复：session-history-hydrator 按 isProviderExecutedToolPartMetadata 重新切轮
```

不变量：

- 服务端执行的调用只展示、落盘和回放，不进入本地工具调度（依赖 turn-model-step / streaming-tool-coordinator 的 `providerExecuted` 过滤）。
- 每轮的正文和思考只属于该轮，不与其它轮拼接，也不挪到最前面。
- 流结束、失败或被取消时仍没有结果的轮，由 settleUnfinishedProviderToolCards 按中断收口：卡片补 Result 终态、
  error 状态的 tool part 落盘，回放为 tool_use + 错误结果（与本地工具中断一致），不留下悬空卡片或没有结果的调用。
- 已切成轮次的服务端调用不参与终态判断（续写、超窗、fileChanges），空结果判定仍算作有内容；
  未切轮的 provider 调用（web_search 等）仍按完整 tool call 处理。
- 作废的 assistant 消息（StreamRecoveryDiscarded）在冷恢复时剔除正文、思考与服务端轮次 part（它们是流中提前落盘的），
  保留退回前已结算的本地工具调用与结果。
- 只处理流式路径；非流式（modelStreaming=off，正式入口都不使用）不切轮。
- 落盘顺序即流顺序，tool part 必须带 `metadata.providerExecuted: true`；冷恢复与实时回放必须得到相同的请求。
- 同一条持久化 assistant 拆出的 runtime assistant entry 共用 `compactGroupKey`（实时提交与冷恢复都打）：
  compact 按 assistant 开头分组选保留区间、持久化边界按数据库消息算，组数必须一致，否则冷恢复会带回已进入摘要的轮次。
  键就是持久化 assistant 消息 id（实时取自轮次的 `messageId`，冷恢复取 `message.info.id`，两边相同）；
  不能用工具调用 id：它只保证单次响应内配对，相邻两次响应可能复用同一个 id 而被并成一组。
- 有轮次的响应不挂 `tokens`（实时与冷恢复一致）：服务端 usage 是多轮合计，当估算锚点会高估约一倍；
  估算回落到上一个真实锚点加本地增量。
- 卡片走 `mcp_tool` 展示，不设置 `display.unavailable`。

行为回归：`apps/zcode-cli/packages/core/tests/provider-tool-rounds/`（契约），
`apps/zcode-cli/packages/adapters/tests/provider-builtin-tool-rounds.test.ts`（真实流 fixture 端到端）。
