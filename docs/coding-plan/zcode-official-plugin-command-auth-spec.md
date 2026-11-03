# ZCode 官方插件命令鉴权规格

> 状态：当前实现事实（2026-10-21）
>
> 官方插件里的命令行工具（目前只有 ZCode Sites 的 `zcode-site`）调用 ZCode API 时的身份来源。
> Agent 侧端点的行为与环境变量见 `apps/zcode-cli/docs/design/v2/official-command-endpoint.md`；
> 官方 MCP 的鉴权见 [zcode-official-server-mcp-auth-spec.md](zcode-official-server-mcp-auth-spec.md)，
> 两者共用 Host 的凭证解析。

## 1. 身份与职责

- 插件命令运行在用户 session 的 Bash 里，同一 session 的任何进程都能读到它的环境变量，所以它
  **不持有凭证**：ZCode JWT、MaaS JWT 都不进命令进程的 env、参数或文件。
- Agent 起一个本地端点，命令把请求发给端点；端点只放行该插件的 API 前缀（Sites 为
  `/api/v1/sites/*`），每个请求向 Host 现取身份头、补上 `X-ZCode-App-Version` 后转发给 ZCode API。
- Host 仍是唯一的凭证 authority，经现有反向请求 `interaction/requestOfficialMcpAuthHeaders` 发放：

```text
zcode-site ──session token──▶ Agent 端点 ──requestOfficialMcpAuthHeaders(consumer=plugin-command)──▶ Host
     ▲                            │                                                                  │
     └──────── 响应原样流回 ◀──── 补身份头，转发 ZCode API ◀──────────────── 身份头（只在本次转发使用）
```

## 2. 协议

`interaction/requestOfficialMcpAuthHeaders` 的请求参数增加可选的 `consumer`：

| consumer            | mcpKey   | 凭证解析                                                                  |
| ------------------- | -------- | ------------------------------------------------------------------------- |
| 省略 / `mcp-server` | 必填     | 现有规则：选中 Coding Plan 无有效套餐时返回 `official_auth_plan_required` |
| `plugin-command`    | 不得携带 | 套餐可选：见第 3 节                                                       |

- schema 仍是 strict；`plugin-command` 带 `mcpKey`、`mcp-server` 缺 `mcpKey` 都按参数错误拒绝，不触发凭证解析。
- 旧 Agent 不发 `consumer`，行为不变。
- Host 的可信校验只看 `targetOrigin`；`pluginId` / `mcpKey` 只用于日志。
- 首次发放日志沿用官方 MCP 的格式，额外记录 `consumer`。

## 3. 套餐可选解析

Sites 的免费档不要求 Coding Plan，命令只需要登录身份；有套餐时仍带 MaaS JWT，服务端据此判定档位。

- 选中的 Coding Plan 没有有效套餐（过期、类型不符）时，`plugin-command` 退回只带 ZCode JWT 的结果。
- 退回前重新读取身份快照；解析期间身份变化则重来一轮，不拼接两代身份。
- 未登录、MaaS JWT 缺失、登录 family 与选中套餐不符，仍返回 `official_auth_unavailable`。
- 两种模式分别合并在飞的请求，互不复用结果。

## 4. 验收不变量

| ID          | 场景                                 | 断言                                                                              |
| ----------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| OPC-AUTH-1  | 有有效 Coding Plan                   | 命令请求带 ZCode JWT 与 MaaS JWT                                                  |
| OPC-AUTH-2  | 已登录、套餐无效或没有选中套餐       | 只带 ZCode JWT；`mcp-server` 同时仍返回 `official_auth_plan_required`             |
| OPC-AUTH-3  | 未登录 / family 不符 / MaaS JWT 缺失 | `official_auth_unavailable`，端点返回不带响应体的 401（错误头 `unauthenticated`） |
| OPC-AUTH-4  | 解析期间身份轮换                     | 不发出两代拼接的身份                                                              |
| OPC-PROTO-1 | consumer 与 mcpKey 组合非法          | 参数错误，不触发凭证解析                                                          |

对应测试：`packages/shared/test/officialMcpAuthProtocol.test.ts`、
`packages/services/test/officialMcpCredentials.test.ts`、`packages/services/test/officialMcpAuthRemoteRouting.test.ts`。
