# Assistant Streaming Text Rendering（当前事实）

Assistant 正文来自 V4 `assistantText` row。CLI reducer 产生 row delta，`ConversationProjectionStore` 应用后，`ConversationRowView` 把当前完整 `row.text` 交给 `MessageResponse`/Streamdown 渲染。

当前没有旧 `useTaskStreamEvents` 50ms batch，也没有 UI 自行维护的逐词 reveal 队列。节奏由权威 delta 到达和 React 渲染决定；结束态必须与 snapshot 中的 row 文本逐字一致。

```text
CLI text event -> ProductProjection row delta -> SessionDataLayer
  -> ConversationProjectionStore -> ConversationRowView -> MessageResponse
```

优化流式体验时不能在 UI 生成第二份正文或用 timer 改写最终文本；合批必须保持 seq、rowId 和 snapshot/delta 收敛语义。

## 长会话流式更新的计算边界

文本追加必须保持当前 reasoning / assistantText 可见更新。消息投影仍是唯一正文来源，
不增加 reveal 队列、延时合批或第二份消息状态。

- 插件展示裁决按回合首次出现的顺序计算最近回合；查重与被替代工具查找不得随历史规模形成嵌套全量查找。
- 导航预览保持既有空白归一、段落上限、字符上限与省略号语义。只扫描足够确定预览的前缀，不能每次追加都先处理所有历史正文再截断。
- 分享关闭时不构建分享回合和摘要；打开后从当前权威快照构建，随后继续响应更新。导航 query 与分享 product turn 的身份语义保持不变，分享目录按回合一次分组。
- 桌面 continuous 与手机 replayable 使用相同纯派生逻辑；主题、语言、滚动跟随与分享选择行为保持不变。

```text
row delta → 权威 projection → timeline / 当前文本
                           ├→ 有界导航预览 + 线性插件裁决
                           └→ 分享打开时构建目录
```

回归覆盖长历史下 thinking 和正文持续追加、最终文本一致、导航预览及分享开关。
性能证据必须记录加载行数、数据形状、构建、平台与消息节奏；React Scan 用于更新原因，
关闭 Scan 的同场景 profile 用于耗时比较。组件夹具不能代替完整应用链路证据。
