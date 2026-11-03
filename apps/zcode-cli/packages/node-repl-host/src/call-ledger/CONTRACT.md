# node_repl 调用账本

规格：`apps/zcode-cli/docs/design/v2/tool/20-node-repl-call-ledger.md`。

```text
tools/call → ledger.open(requestMeta) → token（经 workerData 交给 Worker）
CUA broker / 浏览器代理 broker 收到请求 → ledger.resolve(token) → 会话信息取自条目、事实写入条目
toMcpRunResult(run, facts) → 可信 key 只取 facts
tools/call 结束 → close()：之后带这个 token 的请求一律拒绝
```

- 账本是本次调用可信事实的唯一来源；Worker 发来的结果消息只当作内容，不当作事实。
- 事实包括 CUA 目标应用、浏览器截图，以及会话能力标签用的 `browserUse` / `computerUse`：broker 收到带有效 token 的请求就记，不论成败（`docs/design/v2/model/session-features-header.md`）。
- token 每次调用一个，只在条目打开期间有效；cell 只拿得到自己的 token。
- broker 只用条目的 `requestMeta`（来自 core 的 MCP 请求）构造会话信息，不采信 Worker 自报的值。
- 浏览器代理只转发、记录成功截图，不改上游的校验与错误；读行开销随数据量线性增长（主线程为所有会话共用）。
- 已知缺口：cell 可经 `node:inspector` 影响主线程，账本只防住冒充 Worker 结果消息（见规格「可信边界」）。

行为回归位于 `test/call-ledger/`，CUA broker 一侧位于 `test/cua-bridge.test.ts`。
