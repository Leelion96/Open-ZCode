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
