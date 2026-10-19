# v3.16.1 合并边界

将上游 `0a1fc56d279fd1001f78387bd81aec1c26767411` 合入当前分支，沿用上游实现、模块拆分、代码风格与换行，不进行无关格式化。保留本地历史及未跟踪的 audit 资料。

- 品牌、应用身份和资料隔离继续由原五字段 `config/product.json` 与 shared/product 派生；新增和迁移后的入口接回同一公共常量，不复制状态或配置。
- 保留用户、项目资料隔离和显式路径优先级，不导入官方用户资料；上游会话、项目、远程身份和数据库迁移保持原顺序与校验。
- 模型配置以本地模板、排序、能力和参数覆盖为准，仅吸收上游新增且不与本地定制冲突的模型规则；开发与生产保持同一份定制。
- 保留自建第一方服务地址、公告及官方账号/套餐/Highspeed、遥测的既有边界。Relay V2 按上游接口接入，不扩展本次服务端实现。
- 上游删除的组件直接删除，将仍需保留的品牌及隔离接线放到上游替代入口；不恢复旧侧栏、旧 Remote Host 或第二份会话列表。
- 新增远程身份迁移、引导使用证据、Office 导入及备份卷目录消费同一资料常量；已发布迁移的 checksum 原文不改，只在执行时解析产品命名空间。独立 Web 列表复用上游现有活动合并函数，不恢复被删除的辅助模块。

```text
config/product.json → 原构建入口 → shared/product → Desktop / Web / Host / Agent
所属 Host / CLI → 上游项目与会话迁移 → 上游目录与侧栏投影
桌面 continuous ──┐
                  ├→ 同一 Host owner / lease；不新增任务或恢复状态
手机 replayable ──┘
```

验证包括无未合并项、品牌和路径接线、模型配置一致性、根 typecheck/lint/architecture、CLI 检查及定制相关回归。使用上游构建入口验证受影响的 Web/HTTP/Agent；不以测试通过代替真实远端、手机或跨平台验收，实际未执行项如实记录。

## 审查后补齐规则

- 内置 stdio 插件的两种既有启动配置均传递 Host/Agent 已解析的完整五字段产品配置，使用现有 `ZCODE_PRODUCT_CONFIG_JSON`。独立插件消费同一 shared/product 解析器，不另设 Office 开关、不改第三方插件或 HTTP MCP。
- 项目 Agent 管理、运行时快照和文件监听共用 `resolveWorkspaceSubagentRoot`；隔离开启时只读产品目录，关闭时沿用上游目录。Host 继续拥有快照，首轮与后续轮次的读取/发布顺序、workspace identity、失败及销毁语义不变。
- 独立 Share 的开发/生产入口复用 `loadProductConfig`，注入同一产品常量与 HTML 标题。继续操作使用现有协议派生值；更换名称、关闭身份隔离均由五字段配置决定，不新增分享协议或账号状态。
- 补齐新增英文提示，以及 Workflow 保存、MCP 设置/Agent 标签、插件权限说明、指南推荐提示和更新弹窗的自有品牌文字/alt。复用原国际化变量或产品名称常量，保留原布局、交互、技术 ID、第三方署名和历史兼容标记。
- 四处既有上游文件只接回原目录解析器/产品名称常量（含前次合并的两处远程资料根适配），沿用架构策略现有的精确路径编辑例外；不接管整个 host、session、subagents 或 UI 目录，不放宽层级、依赖或循环检查。

```text
产品配置 → shared/product → 既有 stdio 启动配置 → 插件进程环境 → 同一目录解析
                          └→ Share 构建 → 页面名称 / 继续协议
项目 Agent 目录解析 → 管理列表 / Host 快照与监听 → CLI 本轮定义
桌面 continuous 与手机 replayable 沿用同一 Host owner，不增加状态或恢复链路。
```

回归先验证未修复时失败：插件配置跨真实进程仍保持隔离；管理列表与运行时快照一致且忽略另一命名空间；Share 构建配置和最终 HTML/继续协议一致。完成后运行根与相关 CLI 类型、lint、架构、定向回归及实际插件/页面验证，不以源码层手工注入环境替代启动边界验证。

## 合并与验证记录（2026-10-19）

- 30 个冲突路径全部解决。删除两个上游已退役组件，保留上游项目、侧栏、Source Server 与 Relay V2 主链；产品配置五字段及既有隔离开关不变，无批量格式化。
- 模型配置 revision 34：保留原模板顺序、模型能力、参数映射、禁用官方套餐和个人覆盖，只新增 MiMo Token Plan 与对应两项模板规则，并采用上游 MiMo API 展示名；生产/test 语义完全一致。
- 使用 Node 24.14.0、pnpm 10.33.2 验证。根 typecheck、architecture 通过；根 lint 为 0 errors / 97 warnings；CLI 全部类型检查 32/32 tasks 通过。
- Desktop（不重新准备 runtime assets）、Web、HTTP/remote Server 构建通过，CLI/Node REPL 及四个 Office 插件依赖构建通过。
- 定向根回归 21 文件 / 324 项通过；隔离迁移及 checksum 6 项、多目录 Agent 12 项、Office runtime 70 项通过（计数有重叠，不相加）。新增迁移和 Office 隔离测试均先复现失败再通过。
- schema 合同 8 项、架构工具 36 项通过。完整 pre-push 在 affected 的 push 脏工作区检查处退出；合并期间有已暂存改动及用户原有未跟踪 audit，未移动、删除或忽略该资料来绕过检查。单独执行 worktree affected 选择 2045/2045 个规格，按上游规则跳过全量根 UT，未宣称这些测试通过。
- 扩展 CLI 测试未全绿：adapters 25 项、core 39 项断言失败；bootstrap 首轮 18 项失败，其中三个超时用例单独复验全部通过，其余 15 项仍失败；CLI 程序测试 509 通过 / 9 失败，官方登录 polling 用例因缺少本地已移除的套餐配置持续挂起，停止该测试 worker 后结束。失败包含上游品牌文案、官方账号/市场、默认模型映射与现有定制的预期差异，以及自定义 CA 信任拼接；未修改上游断言以制造全绿。动态工作流 1983 项、其 runtime 98 项、TUI 217 项通过。
- CLI lint 保留 2 项 max-lines 错误（plugins/index.ts 882 行、transcript-hydration.ts 1889 行），未拆分上游大文件或增加豁免。全仓 fmt:check 报 2186 个文件格式问题，仅检查，未批量修复；README 的既有 Markdown 双空格换行保留。
- UI 静态检查有 148 项全仓命中，本轮相对上游的修改行命中为 0；按用户最小合并范围不重设计上游界面。未进行真实桌面数据迁移、手机/SSH 联调、Windows/Linux 实机或完整安装包验收。

## 审查补齐验证（2026-10-19）

- 修复前，新增插件跨进程用例 5 项失败；Share 构建配置与品牌插值、项目 Agent 快照用例均复现遗漏。修复后定向根回归 10 文件 / 145 项通过、1 项既有跳过；bootstrap 插件 runtime/cache 12 项、Office 文件导入 6 项通过。项目 Agent 同时覆盖隔离开/关及文件修改后的快照更新。
- 使用重建后的真实 Agent、manifest 重写和 MCP stdio 链路运行 documents/pdf/presentations/spreadsheets，四个插件均完成 begin/write/finish 导入，工作区仅出现 `.open-zcode/document-imports`。子进程产品环境只来自启动配置，没有向子进程手工补值。原生权限说明的两种语言也验证了自定义名称与身份开关的独立性。
- 独立 Share HTML 构建产物使用 Open-ZCode。复用现有 Chrome，英文页与 390px 中文页均显示正确品牌、正常正文、无横向溢出，继续链接均为 `open-zcode://share/import?...`；只检查链接，不触发实际导入。验收后恢复浏览器尺寸、关闭测试标签、停止本地 fixture 服务，并恢复普通环境的 Share 构建产物。
- Node 24.14.0 / pnpm 10.33.2 下，根 typecheck、lint（0 errors / 97 warnings）、完整与本轮差量 architecture 检查通过；架构工具 36 项通过。相关 bootstrap typecheck 通过，Desktop/Agent/Share 构建通过；未执行批量格式化，五字段产品文件及模型配置未改动。
- 既有 CLI lint 仍有 2 项大文件行数错误。扩展的分享错误页测试仍有中英文两项期待官方首页入口的断言失败，与当前自建版下载/首页地址为空的既有规则不一致；相关页面和测试本轮未改，不以改断言或恢复官方入口制造全绿。Vite 测试使用显式空 endpoint 覆盖验证默认地址分支，避免本机自建地址影响其已有断言。
- UI 静态审计仍有 148 项原有命中，本轮修改行无新增命中。未验证 Windows/Linux 原生窗口、完整安装包及手机远控联调；没有迁移、清理或覆盖用户真实资料。
