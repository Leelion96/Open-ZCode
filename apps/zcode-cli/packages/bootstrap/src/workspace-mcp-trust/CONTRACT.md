# Workspace MCP trust

目标 Host 持有用户域记录。`inspect` 不连接；`decide` 在锁内重读精确声明并原子写入；
`allows` 在连接准入时重验；`guard` 包住整个 MCP lease，保护连接、复用、工具与资源。
未知、陈旧或损坏记录默认拒绝。插件与用户级普通 MCP 不属于本模块的审核范围。
会话内请求、状态查询及底层自动重连复用本次 gate 的内存准入结果。
撤销和配置变化在新建/重启会话或显式重新配置连接时生效；提示刷新不改变现有授权。
显式断开、关闭与 gate 失效立即阻止使用；不回滚已提交副作用。UI 只接收摘要、来源与脱敏声明。
完整 spec：`docs/runtime-tools/mcp-status-list-control-plane.md`。

`guard` 的可选 AbortSignal 只使当前 gate 失效，不关闭共享 raw lease；设置 owner 串行清理后交给下一工作区。
订阅按 subscriber 释放不受执行授权拦截。无效声明不提供审核摘要，正常用户来源不受项目读取错误影响。

可选 `onAdmissionChanged` 接收待审核数量、集合摘要与 workspace identity。guard 的
`refreshWorkspaceTrustAdmission` 串行重读并发布变化，只更新会话提示，不连接、不授予权限。
关闭 gate 后不再发布，首次无待审核项不发事件；授权记录仍是唯一执行授权来源。
