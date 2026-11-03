# MCP UI 注册展示模式与打开卡片

`availableDisplayModes` 是页面在 MCP Apps 握手中声明的展示能力。宿主只展示双方支持的模式。工具行的 `preferredDisplayMode: fullscreen` 指定侧栏展示：只要页面支持 fullscreen，对话始终显示打开卡片，不渲染 inline；关闭侧栏也不回 inline。未声明能力的旧页面同样遵守该规则。若页面仅支持 inline，则仍按注册能力使用 inline。

| 页面声明             | 对话中的入口                       | 侧栏                       |
| -------------------- | ---------------------------------- | -------------------------- |
| 未声明               | 沿用 inline / fullscreen           | 可打开                     |
| `inline`             | 内联页面，无侧栏按钮               | 不自动打开，不接受切换请求 |
| `fullscreen`         | 插件打开卡片，无内联页面和固定按钮 | 点击卡片按钮打开           |
| `inline, fullscreen` | 沿用内联页面                       | 可打开；关闭后回内联       |
| 空集合或仅 `pip`     | 普通工具记录                       | 不提供不支持的入口         |

上表的未声明和双模式行为适用于未指定 fullscreen 的工具行；指定 fullscreen 后，这两类也只提供侧栏入口。`showInline` 或手动固定不能覆盖该选择。surface 侧栏从现有 feed 的最后一次成功结果读取展示选择，失败或未完成调用不改变它。

页面声明只能在握手后获知。因此首次启动使用已有 inert 后台表面完成握手，在能力确定之前不展示 guest，也不消费 fullscreen 自动打开偏好。资源结果到达后启动；初始化错误仍可重试。未声明模式兼容旧页面。

```text
成功工具结果 → 唯一页面 owner 后台启动 → initialized / capabilities
                                         ├─ inline 可用 → 内联锚点
                                         └─ fullscreen 可用 → 卡片按钮 / 首次偏好 → 侧栏锚点
fullscreen 注册或工具行指定 fullscreen → 关闭侧栏 → 打开卡片；同一 guest 保活
重新挂载历史工具行 → 读取同一 owner；已消费的自动打开不再执行
```

展示约束同时用于 guest 的锚点选择、hostContext 的可切换模式和页面请求。只注册 fullscreen 的页面请求 inline 时保持 fullscreen，不关闭侧栏；只注册 inline 的页面请求 fullscreen 时保持 inline。页面 capabilities 归现有页面 owner，不在 React 中另存副本。身份、代际、工具结果路由与 continuous/replayable 边界保持原有归属。

隐藏 inline、关闭侧栏和切换会话只改变展示锚点，不调用 reload / suspend / destroy，不新建 WebView，也不重新读取资源或握手。后台保留同一个 guest，插件内存状态与异步执行继续；再次打开侧栏复用该实例。回归同时断言 guest ID、启动次数、资源读取次数、内部 React 状态和后台执行均保持。

打开卡片使用现有 PluginIcon：左侧插件图标；中间插件名称和“在侧栏打开 / 已在侧栏打开”；右侧侧栏图标与“打开”按钮。名称、图标复用 session catalog 投影，缺失时显示插件短名和通用插件图标。不从任意工具参数推测文件名、页数或进度。关闭侧栏、回到会话和展开历史不会恢复 fullscreen-only 的 inline。长名称省略，操作按钮保留；使用语义 token、深浅主题和中英文。

Web、手机和远程工作区继续沿用不支持 MCP guest 时的普通工具记录，不新增沙箱能力。

验证：扩展真实 Electron 时间线 `mcp-apps-host-e2e.mjs --rows-only`，覆盖握手前隐藏、fullscreen-only 手动打开/关闭/请求 inline/重挂/新调用、inline-only 拒绝 fullscreen、未声明与双模式兼容、失败与取消门禁。定向单测覆盖模式交集、请求无副作用及 session 图标投影；`--managed-only` 回归 Web/remote 回退与页面保留。此处受控 Electron 证据不代表 Windows/Linux 或真实手机设备验证。
