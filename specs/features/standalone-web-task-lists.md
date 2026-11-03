# 独立 Web 的任务列表

## 范围与规则

- 独立 Web（连接 `/ws`）的 HTTP Server 没有窗口 Controller。Web 入口通过现有可选的 `windowControllerService` 表达这一差异，共用列表 hook 改用已有 `zcodeTaskService.listTaskList`。
- 这是上游 3.14.3 已有的列表读取缺口，与本 fork 的品牌和资料目录隔离改动无关。
- 手机连接桌面（`?remote=...`）和桌面 Renderer 继续走窗口 Controller；不改变 Host attachment、Agent 启动、会话恢复、owner/lease 或两种流式交付语义。
- 任务、置顶、归档及分组使用的共用列表读取都遵循这一选择。项目行仍走原有读取路径，分组结构与写入命令不变。
- `active` 的口径与 Controller 一致：包含普通与置顶任务，排除归档任务。独立 Web 合并现有 timeline/pinned 分区查询；不修改服务端原有查询语义。
- 普通列表读取当前打开的 workspace scopes；v3.17.1 命令中心的 `host` 查询由 Host 索引读取该 Host 全部历史，不受已打开 tabs 限制。身份键仍为 `workspaceIdentity?.trim() || workspacePath`，不扫描其它目录，不迁移数据。

## 唯一所有者与接口

- tasks-index 是持久任务行、置顶、归档、删除与未读状态的所有者；已有任务服务负责查询与写入。
- sessions-index 是实时会话状态的所有者。Web 复用已有共享订阅，只补充已存在的任务行，不把 session-only 的摘要变成历史记录。
- 共用 `useGlobalTaskList` 增加读取路径选择，保留上游 Controller 的查询、订阅和缓存逻辑。独立 Web 的读取结果、加载状态及实时投影集中在 `useStandaloneTaskList`，无 Controller 时启用。
- 不增加数据库、任务状态服务或第二条写入路径。停用的 Web hook 不查询任务，也不订阅任务事件或实时会话。

```mermaid
sequenceDiagram
    participant UI as Web 列表 hook
    participant Tasks as 已有任务服务 / tasks-index
    participant Sessions as 已有 sessions-index 订阅
    UI->>Tasks: 按 scopes、列表种类和搜索查询
    Tasks-->>UI: 持久任务行
    Sessions-->>UI: 实时会话摘要
    UI->>UI: 复用现有行合并、排序，再按显示上限截取
    Tasks-->>UI: 任务创建 / 元数据 / 归属变更事件
    UI->>Tasks: 重新读取持久行
```

实时摘要只重新计算展示列表；低频任务事件通过已有 membership 版本失效后重查，避免流式输出逐帧触发任务 RPC。查询返回前 scopes 或请求代次发生变化时，旧结果不能覆盖新列表。

## 失败语义

读取失败沿用上游处理：记录错误日志、保留最后成功的列表，并结束加载状态。首次读取失败时列表仍可能显示空态，用户可以刷新页面重新读取。本次只修复读取路径，不增加错误文案、重试组件或其它页面改动；不用超时探测 Controller 或自动重试循环。

## 验收

1. 使用现有用户数据打开独立 Web：任务区能显示 conversation workspace 的历史记录，项目行仍正常；刷新页面后记录仍在。
2. 打开历史任务可以加载聊天内容；新建、改名、置顶、取消置顶、归档、取消归档通过原有命令更新对应列表。
3. 分组视图能读到同一持久任务集合；搜索正文仍保留服务端搜索摘要。
4. sessions-index 更新只补充已有行，运行任务按现有规则排序；分页在补实时信息后截取。
5. 读取失败记录日志并保留已加载列表，成功空列表显示原有空态；旧请求不能覆盖新的 scopes 或排序。
6. 桌面及手机远控继续选择 Controller，不增加独立 Web 的任务事件和 sessions-index 订阅。

自动验证覆盖列表分区与搜索条件、任务身份、读取错误传递、实时排序和分页；浏览器交互验证覆盖历史显示、打开、刷新及归属操作。实施后执行 typecheck、lint、架构检查和 Web 构建。

## v3.17.1 查询适配与回归入口

- query 支持 workspace 数组及 `host`，查询直接交 TaskService；实时订阅由返回行的真实目录派生，不遍历磁盘或启动历史 Agent。
- `enabled=false` 和存在 Controller 时将独立路径置为 null，释放订阅、不调用查询；请求代次拒绝旧响应。
- App 业务单测已退役，候选浏览器验收：`node packages/ui/test/browser/manual-review/pending/standalone-task-list.test.mjs`。
- 该场景运行真实 React hook 和列表派生，仅在 RPC/sessions-index 边界提供夹具，覆盖 host 数组隔离、active 合并/搜索/排序/分页、迟到响应、失败保留以及停用释放。结果保存在 `packages/desktop/.e2e-artifacts/standalone-task-list`。
- 真实验收使用现有 Web 实例及用户资料，补充历史打开、刷新和命令中心；修改的用户元数据恢复原值。候选浏览器通过不代表已完成手机远控验收或人工转正。
