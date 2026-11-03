# Chat Composer Placeholder

聊天输入框 placeholder 现在按任务状态和终端宽度分流：

- 空闲态，无历史消息（桌面端）：`Ask ZCode anything, @ for files, folders, or whiteboards, / for commands or agents, $ for skills, # for related conversations`
- 空闲态，无历史消息（手机 Web 远控）：`Ask ZCode anything…`
- 空闲态，有历史消息：`Ask for follow-up changes`
- 处理任务中：`Keep typing to queue follow-up changes`

设计约束：

- 新任务占位文案只在消息列表为空时显示
- 历史任务只要已经有消息且当前不在处理，就显示 follow-up 文案
- `submitting`、`creating`、`restoring`、`streaming` 统一视为处理态，避免任务启动瞬间 placeholder 闪回
- 处理态不锁定输入，只改变 placeholder，明确告诉用户可以继续输入并进入队列
- 手机 Web 远控的新任务文案保持精简，完整的 `@` / `/` / `$` / `#` 能力提示由输入框下方动作入口承载
- 手机 Web 远控的 placeholder 最多展示两行，作为国际化文案扩展的布局防护；不能覆盖下方工具栏
- 桌面端继续显示完整能力提示，不受手机端精简规则影响
- 文案通过 i18n 配置，当前提供 `en-US` / `zh-CN`

## 首发交接

发送开始到权威输入投影接管之间，沿用本地 submitting 与 projection store 的
`optimisticCommands` 派生处理态；不新增 placeholder 状态或延时。处理态优先于“无历史”，
避免 ACK 清空正文后，消息投影尚未到达时闪回新任务提示。命令投影接管后恢复由当前
会话控制状态和历史消息派生；失败回滚沿用现有命令移除边界。

命令投影按命令的目标 session 获取既有 store，并在命令完成后释放租约。首发等待预热时，
发送回调捕获的页面 lease 可能尚为空，不能用它决定是否登记待投影命令；切页也不能把旧命令
登记到新页面的 store。投影登记与清理始终使用同一个目标租约。

CST01 记录真实编辑器 placeholder 的 DOM 变化：首发清空至消息投影到达期间不能显示
新任务提示；完成后显示追问提示。保留桌面完整文案、手机短文案及现有主题/i18n。

## 已有会话切换的投影等待（SSV01）

已有 sessionId 但当前会话快照尚未到达时，输入框不显示新任务 placeholder。保持同一编辑器和该会话草稿；快照到达后直接显示运行中排队或已有历史提示。发送与停止仍由当前会话权威状态决定，不借用上一会话快照，也不增加延时。桌面与手机共用此规则。

同一等待窗口内，模型选择 owner 不把空 selection 的新任务默认值作为已有会话配置。模型菜单按会话隔离显示与动画；只有当前会话已知选择可显示，恢复配置不触发用户改选动画。
