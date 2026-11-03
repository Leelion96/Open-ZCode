# Settings MCP list

MCP server rows present ownership scope as compact metadata beside the server name.

- User and Workspace scope use the shared `Badge` treatment from Skill rows.
- The badge uses `rounded-full`, `border-border`, `bg-surface`, and `text-ui-sm`.
- A 14px leading icon identifies the scope: `UserRound` for User and `Folder` for Workspace.
- Scope labels remain the localized `User` / `Workspace` values.
- Configured MCP rows do not display their backing configuration directory path; location data remains available to configuration and editing logic.
- Runtime status dots and server names share a layout wrapper, but the name-only element owns `text-foreground`; status colors do not inherit from the server-name text style.
- Disconnected or unknown status dots use the tertiary foreground token `text-foreground-subtlest`; connected, connecting, and error retain their semantic colors.
- Hovering a status dot shows the reason. Configured servers use localized runtime explanations and prefer the actual server error when available; plugin servers reuse their resolved status description, including disabled and authorization-required explanations.
- Status-reason tooltips use `max-w-64` so longer explanations wrap within a compact 256px width.
- Item descriptions use `text-ui-sm text-foreground-subtle` as secondary copy.
- Tool-count metadata uses `text-ui-sm` in both configured and plugin-provided MCP rows.

Plugin-provided MCP rows show plugin ownership beside the MCP server name.

- Plugin ownership由所在分组标题表达，行内不重复显示 Plugin badge 或 marketplace。
- Plugin names use the canonical display-name formatter, including converting slug-like names into title-cased words.
- Plugin MCP 按稳定 `pluginId` 分组；同名不同 id 不合并。Plugin 分组按规范化 display name 排序，组内待处理项优先，其余保持声明顺序。
- Runtime status is represented only by the status dot and its hover explanation; plugin MCP rows do not repeat status as a text badge. Tool count remains separate metadata.
- Plugin MCP names reuse the configured-server status dot: connected is green, connecting is a yellow spinner, errors are red, disconnected or unknown is tertiary foreground, and authorization-required is a static yellow dot. Plugin-disabled is part of this status resolution and takes precedence over stale runtime state, always rendering a static tertiary-foreground dot.

Configured、Plugin MCP 共用一套失败展示：按 `failureKind` 国际化的摘要使用普通次要文字颜色，
错误状态只由 status dot 使用红色。原始 `error` 通过摘要后方的小型信息按钮按需在 Popover 中显示；
服务端 request id 已作为 ` - <requestId>` 后缀合并到这段可选择复制的详情文本，不再单独展示或提供第二个复制按钮。不得从 error 文本反解业务分类。
连接成功、重新连接或 workspace 切换必须清除旧诊断。

官方 Server MCP 的 JSON-RPC 错误码会先转换为稳定的设置页分类：`1006` 显示“未登录，请先登录
ZCode”，`3101` 显示“当前账号没有 Coding Plan，请先购买或配置 Coding Plan”；这两类提示不再
显示为笼统的“协议请求失败”。

MCP、Skills、Commands 共用 `SettingsResourceGroupHeader` 与 `SettingsResourceList`：分组间
`space-y-6`、组内 `space-y-4`、标题 `h-7 text-ui-base`、数量 `text-ui-sm`、列表
`rounded-xl bg-surface`，行间使用独立 `h-px bg-border/50`。

Workspace 直接 MCP 行提供「信任 / 撤销信任」，与启用开关独立。审核对话框复用确认组件，
显示目标 Host 返回的脱敏有效声明及源路径；授权只提交该行精确摘要。切换目标后旧对话框
不得提交。信任后仅刷新状态；用户手动刷新或后续会话启动才连接。Plugin MCP 不受本轮影响。
审核声明使用现有 `CodeBlock` 展示 Host 已脱敏的 JSON，保留缩进并提供语法高亮、等宽字体与复制。
说明和源路径与代码分区；代码默认换行、独立滚动，桌面与手机的确认按钮保持可见。
代码主题跟随应用深浅主题；复制按钮的 Enter 只复制，不触发信任。

候选验收 WMT-01：Desktop 设置 → MCP → 当前工作区，首次刷新不启动 fixture；逐条信任
持久化但不连接；手动刷新后握手成功；撤销后显示待信任。用例位于
`packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-workspace-mcp-trust.test.ts`，尚未转正。

WMT-02：通过隔离本机 relay 配对的 390px 手机 Web 对同一 Host/workspace 声明信任与撤销；
直接检查同一用户域记录，并保存手机界面证据。使用测试账号与本机服务，不访问真实账号。

工作区 MCP 行只显示传输类型；命令、参数与连接地址在 Host 脱敏后的审核摘要中展示，
避免在审核前由列表直接输出 URL query 或命令参数中的凭据。
窄屏把信任操作放到下一行，保留名称和信任状态的阅读宽度。

会话输入区沿用 Hooks 的图标弹层，在权限控件旁显示独立 MCP 图标和未读点；MCP 图标统一使用
与设置页「MCP 服务器」相同的 `Cable`，保留原有尺寸与主题前景色，桌面和手机 Web 一致。点击后清除未读点，
弹层显示待信任数量和生效说明，提供「去审核」与「忽略」。关闭后保留图标，忽略当前声明后隐藏。
去审核直达本会话工作区的 MCP 设置；授权/撤销后同工作区活跃会话刷新提示，忽略仅隐藏当前声明。
已有运行会话（包括自动重连）沿用原授权，新建或重启会话时重新检查；设置刷新只更新自身连接。
提示与设置行明确区分持久声明状态和运行中会话的授权结果。
设置行使用独立 `untrusted` 状态和明确的待信任文案；缺少审核详情时不误报连接故障，信任按钮仍禁用。
