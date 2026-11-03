# provider-builtin-tool-compat

服务端执行内置工具后，会在一条 assistant 流里依次下发：调用头 markdown → `server_tool_use`（SDK 不认识的名字）
→ 结果 markdown → 裸 `tool_result` → 下一轮。本模块把结构化块改写成 AI SDK 原生支持的
`mcp_tool_use` / `mcp_tool_result`（provider 执行），并去掉与之重复的 markdown 渲染。
规格见 `apps/zcode-cli/docs/design/v2/model/anthropic-stream-compat.md`「Provider 内置工具多轮回放」。

不变量：

- 只改写 SDK 不认识的 `server_tool_use`；SDK 已支持的名字（web_search、code_execution 等）原样透传。
- 裸 `tool_result` 只有和前面的服务端调用 id 配对时才改写；没配对的交给 anthropic-stream-compat 按原规则丢弃。
- markdown 副本按结构确认，不只凭前缀：调用头必须以 `**🌐` 开头且下一个块就是服务端调用；结果副本必须以加粗开头、
  紧跟服务端调用，且下一个块就是这次调用的配对 `tool_result`。确认前先缓冲，确认不了就原样放行，
  所以服务端缺少配对结果时，紧跟调用的加粗正文不会被删。
- 状态按 message 维护，`message_start` 时清空；流结束时补发仍在缓冲的帧，不吞内容。
- 纯协议变换，不做 IO；只由 anthropic-stream-compat 在 Anthropic fetch 边界调用。

行为回归：`apps/zcode-cli/packages/adapters/tests/provider-builtin-tool-compat/`（契约），
`model-execution.test.ts` 与 `provider-builtin-tool-rounds.test.ts`（经 AI SDK 的端到端）。
