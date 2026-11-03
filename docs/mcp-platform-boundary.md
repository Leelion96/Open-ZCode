# MCP Platform Boundary

MCP native user-directory management is a platform capability, not a UI-layer capability.
The UI package can render and coordinate MCP settings for desktop, web, and mobile, but it must not call Electron preload APIs directly.

## Boundary

- `packages/ui` depends on `IPlatformService` for native MCP operations.
- Desktop implements the MCP platform methods by forwarding to the existing preload bridge.
- Mobile `/remote` forwards MCP platform requests through the existing shared-host attachment app-payload path to the desktop window that owns the host.
- Plain web without a desktop attachment returns empty/unsupported fallbacks and must not create an independent Agent runtime or local host.

## Methods

The platform abstraction owns these operations:

- `loadMcpFromUserDirectory`
- `saveMcpToUserDirectory`
- `migrateLegacyCommonMcp`

This keeps Electron-specific `window.zcode` access inside desktop renderer bootstrap code and preserves UI reuse across desktop, web, and mobile remote control.

## MCP 2026-07-28 runtime boundary

- 普通 stdio / Streamable HTTP MCP client 缺省使用 dual-era `auto`：先尝试 modern
  `server/discover`，只在 transport-specific legacy evidence 下回退 `initialize`；显式 legacy 配置
  继续跳过探测。
- 内置 `node_repl` 固定使用 MCP `2026-07-28`；每次 `js` 使用一次性执行 kernel，不使用
  `Mcp-Session-Id`，也不新增模型可见的 Browser context handle。
- `_meta` 是 client 提供的请求上下文，不是授权事实；宿主必须用私有 stdio/pipe token、当前
  session registry 和 handle binding 重新校验。
- 同一 Agent runtime 内可按 `workspaceKey` 共享无状态 `node_repl` process；官方市场插件可在 manifest
  声明 `"isolation": "workspace"` 共享（自行按 `_meta.root_session_id ?? _meta.session_id` 划分状态；`root_session_id` 只在 subagent / 工作流子代理的调用中出现，指向派生它的顶层 session，见
  `docs/plugins/2026-10-15-office-viewer-builtin-panels-spec.md` §8）；第三方 server 保持 session isolation，
  其 `isolation` 声明被忽略。
- mobile `/remote` 只复用 desktop shared-host attachment 已有的 Agent/MCP runtime；relay 和
  desktop main 不保存 MCP tool/kernel state 或 conversation state。
- desktop `desktop-continuous` 与 mobile `web-remote-replayable` 的消息投递边界不因 MCP process
  共享而改变。

完整合同见 `docs/mcp-stateless-node-repl.md`。
通用 client 协商合同见 `docs/mcp-dual-era-version-negotiation.md`。
