# v3.17.1 合并边界

将上游 `a60ba6a7e5a06742270ca605f5d2cc2766afa7e1` 合入起点 `5465d17955aa4b3e62480ca96ee99ec2e729b09a`。两个仓库保持 main；客户端正常双亲 merge，Server 单独提交；不推送、不部署。

## 产品裁决

- 完整接入上游功能、模块与 Electron 44。保留五字段产品配置、品牌和资料隔离、普通公告、独立 Web，以及既有官方账号/套餐/Highspeed/遥测边界。不恢复上游已退役组件，不进行无关重构或批量格式化。
- 两份模型 JSON 采用各自上游完整内容，仅删除 10 个官方账号 providerRules 及其 30 条 builtinProviderModelRules。其余模板、排序、能力、参数、revision 原样保留；不改用户显式选择。Server builtin.json 与生产配置一致。
- 更新开关不变；正式包的唯一可信更新源来自构建配置，必须是 HTTPS。保留上游启动参数、哈希、签名与安装校验；运行时环境不得扩大可信来源。未配置自建来源或请求失败时不得回落官方。开发调试入口沿用上游。
- Sites、手机推送等新能力的代码、资源、默认启用和入口完整沿用上游，只做品牌与资料隔离适配。不新增隐藏逻辑、未接入提示或服务端业务。
- Server 仅同步模型配置、现有插件目录及必要规范/验证；保留付费条目过滤和原始官方包地址，不新增 API、数据库迁移、包托管或部署。
- 接受 App 业务单测退役及新的工程/E2E 门禁；必要定制回归转为 E2E 或可重复运行时场景，不能保留无入口测试或将历史单测证据当作当前覆盖。

## 查询与所有权

独立 Web 继续复用 TaskService。查询接受 workspace 数组或 `host`；host 由持久索引 owner 解析，不能作为数组操作或被已打开 tabs 裁剪。查询范围与明确的实时订阅数组分开；enabled=false 不查询、不订阅。保留 active 的 timeline/pinned 合并、排序、搜索、失败保留和请求代次保护。Desktop/手机仍走 Controller。

```text
构建配置 → 品牌 / 资料位置 / 可信更新源 → Desktop / Web / Host / Agent
过滤后的上游模型配置 → 客户端随包配置 + Server 静态下发
TaskService 查询 → Host 组织态索引；执行 → CLI 会话事实
desktop continuous / mobile replayable → 原有 owner、序号与恢复路径
```

共享 CLI、单任务重启、项目清理、远端同步沿用上游 owner；workspaceIdentity 不替代 cwd，旧 migration/checksum 不改。项目清理验收仅使用可丢弃样本，不能删除用户原始数据。

## 验收

- 客户端 typecheck、lint、architecture、schema、受影响工程及相关 CLI 检查；Desktop/Agent、Web、Server 构建；E2E 修改执行 typecheck:e2e。Server verify、plugins:check。
- 可信更新源固定、自定义启动参数拒绝、501/断网不回落；模型差异仅两组删除且 Server 同步。
- 独立 Web 历史/全 Host 搜索/停用/置顶归档/刷新/实时状态；桌面及手机原路径。
- 共享 CLI 单任务重启隔离、草稿和历史恢复；新增功能的品牌与隔离开关；图片标注、文件打开、项目管理和插件资源。
- 复用正常应用实例和现有资料；新 E2E 保留候选状态，不自动转正。环境限制及原有失败单列，不删断言或放宽门禁制造通过。

## 实施与验证记录

2026-11-03：37 个冲突路径全部解决（29 内容、8 修改/删除）。上游退役组件和 App 单测按裁决删除；保留新生命周期、共享 CLI、同步、Sites、图片编辑及 Electron 44。新个性化、数据同步、Sites 项目绑定均接回同一产品目录规则，未改旧迁移 checksum。

- 模型两份 JSON 与固定上游进行结构比较，差异严格限于两组账号规则删除；Server 与生产 JSON 完全相同。revision 43 包含 34 个模板、314 个模板成员及 316 条模板模型规则（上游保留的两条旧型号规则原样保留）。
- 客户端使用 Node 24.14.0 / pnpm 10.33.2：根 typecheck、lint（0 errors / 83 warnings）、architecture（0 violations）、E2E typecheck、文档陈旧措辞检查通过。CLI typecheck 34/34 tasks 通过；Agent 构建及暂存、Desktop production（不重复准备 runtime assets）、Web、HTTP/remote Server 构建通过。构建的大 chunk、动态 import 及 Turbo output 告警保留。
- schema 合同 8/8、两库 schema 兼容性、架构工具 51/51 通过。affected 工程测试选择 157/157，按仓库规则跳过，未执行全量工程套件，不计为测试通过。
- CLI 定向回归：bootstrap 生命周期/协议/会话数据 5 文件 51 项，core 历史/Gen UI/输入预测 3 文件 47 项，Sites 27 项 Node 测试及 6 文件 68 项 Vitest 均通过。未运行全量 CLI/CUA 或桌面 E2E。
- 可信更新构建规则 6 项通过。真实 Electron 更新器回归分别使用 MacUpdater、AppImageUpdater、NsisUpdater，共 33 场景通过；独立官方哨兵端点证明 501、断网、缺配置时没有回落官方。NSIS 签名和安装顺序为受控替身，不代表 Windows 实机签名验收。快速失败曾抢先关闭 Playwright 上下文，改为父进程完成连接后显式启动场景，最终三组全部通过。证据：`.e2e-artifacts/update-source-security-DRSFya`、`update-source-security-tBzcuZ`、`update-source-security-tjGzq6`（均位于 packages/desktop）。
- 独立 Web 候选浏览器 5 个场景通过，覆盖 host 查询、显式目录订阅、active 分区合并/搜索/排序/显示上限、迟到请求、失败保留和停用释放；证据在 `packages/desktop/.e2e-artifacts/standalone-task-list`，保持 pending，未人工转正。
- 正常 Open-ZCode Dev 44.7.0 实例复用现有用户资料：新增设置页、34 个上游供应商模板加自定义入口可见；真实模型回复成功；单任务重启的历史与草稿一致，重启后继续回复成功；图片标注保存追加第二张 PNG 且不发送。测试附件移除，新增验收任务归档，未改动原有任务。截图保存在 `packages/desktop/.e2e-artifacts/open-zcode-317-real-profile`。
- 正常 Chrome 独立 Web 可打开命令中心和已有最近任务。真实 HTTP Host 的无项目首发被既有 `project.remote-project-required` 拒绝；现有资料行属于 Desktop local owner，不能放宽 host 查询去读取其他 owner，未完成独立 Web 的完整首发/全 Host 历史现场验收。此准入装配在任务基线已有，未扩大合并范围修复。初次直接运行 dev:web 未加载 shell 中的自建 endpoint，出现同 revision 官方内容拒绝；验收重启时显式继承已有环境文件的公开 endpoint，不改配置或 revision 来规避校验。
- UI 静态审计在源码范围报告 153 项（121 violations、32 unresolved）；相对上游的修改行命中 0，不在合并中整库重设计。初始根目录扫描进入生成资源，终止后限定 packages/ui/src 重新完成。未验证真实手机、SSH/WSL/Docker、Windows/Linux、正式签名安装包、双任务持续运行隔离、项目数据彻底删除或云端实际部署；不将这些标记为通过。
