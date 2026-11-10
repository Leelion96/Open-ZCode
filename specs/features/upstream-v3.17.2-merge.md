# v3.17.2 合并边界

将上游 `a9fe401eede6e6e5e01be9048679c206fe6f02d9`（父提交 `a60ba6a7`）合入本地 `1106db38`。采用正常双亲 merge，保留当前产品定制；只在本地提交，不推送、不部署，不修改 Server 仓库。

## 产品与实现规则

- 沿用 [v3.17.1 产品裁决](upstream-v3.17.1-merge.md)：五字段产品配置、品牌、用户/项目资料隔离、自建可信更新源、独立 Web、官方账号/套餐/Highspeed/遥测边界不变。模型配置本次无上游增量，保持当前内容。
- 完整接入上游 Plan/Explore/插件 agent 权限收紧、自定义命令 Bash hand-off、草稿 MCP UI、MCP 诊断、受控 HTML 预览、文件定位和系统打包调整；保留上游 E2E 候选状态，不恢复退役 App 单测。
- 新增用户/项目目录引用须使用既有产品目录解析器；Claude 兼容变量与协议标识保留兼容语义，不将所有 ZCode 字符串机械替换为品牌。
- Host 唯一持有项目归属，CLI 唯一持有会话事实和权限。`0010_remote_task_ownership` 仅修复可证明的远端 NULL 归属；本地 NULL、已有项目及其他组织字段不重写，旧 migration checksum 不变。
- 生命周期启动校验完整 workspace 身份；真实关闭完成后才释放/重建实例。桌面 continuous 与手机 replayable 沿用同一 owner，不能放宽隔离或以超时代替完成。

```text
构建产品配置 → 品牌、用户/项目目录、可信更新源 → Desktop / Web / Host / CLI
CLI fork 提交 → Host 原子继承父任务组织态 → ACK → UI 打开
Host attachment → workspace 归属校验 → 旧 runtime 实际关闭 → 同归属恢复
草稿预热 owner → 插件页面 retain → 首发接纳 → 同 session/guest 正式化
desktop continuous / mobile replayable → 同一 CLI 权限、事实与序号
```

## 验收

- 检查内容冲突、自动合并的定制重叠路径、上游新文件中的品牌和资料路径；记录逐项裁决。
- 根 typecheck、lint、architecture、schema、E2E 类型与 fixture 检查；CLI typecheck/lint 及受影响权限、子代理、自定义命令、生命周期、MCP 回归；打包裁剪工程回归。
- 构建 Agent、Desktop、Web、Server，核对模型/产品配置/更新源保持；工程 affected 若选中全量按现有规则处理，跳过不能计为通过。
- 用现有正常应用和资料验收新版本、历史读取与续发、单任务重启、HTML 预览、文件定位和草稿插件入口。迁移在副本/夹具上验证受影响表和幂等，不损坏用户原始数据。
- 真实执行结果、原有失败及跨平台/手机/远端未验证边界写入本文件，不以历史测试数量作为本轮证据。

## 实施与验证记录

2026-11-10：共 4 个内容冲突路径（README 中英文、protocol-slash-commands 测试 import、desktop main import）。README 保留 fork 说明并更新上游版本；main 同时保留产品常量和新增预览模块；测试保留 vi 和产品隔离回归，删除上游已移除执行器对应的无用类型。

自动合并路径逐项核对：MCP 客户端品牌、subagent 项目目录、Agent 用户目录、Host 资料目录、窗口标题和打包身份均保留本地产品常量。模型两份 JSON、product.json、自建更新源配置与校验相关 7 个文件和合并前逐字相同。本次新命令 hand-off 文案使用中性的 application，CLI/合同/E2E 预期同步；内部协议和 Claude 变量不变。

验证使用 Node 24.14.0 / pnpm 10.33.2（本机 mise 不在 PATH，使用已有 npm 缓存中的固定 Node 二进制）。证据统一位于 `packages/desktop/.e2e-artifacts/upstream-3172-merge/`。

- 冻结 lockfile 安装、根 typecheck、E2E typecheck、架构检查（0 violations）、schema 合同 8 项及两库兼容性、架构工程 51 项、构建配置 6 项通过。根 lint 0 errors / 84 warnings；CLI typecheck 34/34 tasks 成功，CLI lint 0 errors / 73 warnings，另保留 6 项原样上游行数诊断。
- 首轮 CLI lint 发现原有插件加载器 882 行未登记；其实现与合并前完全一致，仅存在更早的两条通用文案定制。按已有规则为该精确文件登记 max-lines warning，不放宽其他规则、不拆分职责。CLI 回归另发现 Explore 提示与两处 CUA 错误预期仍为旧品牌文字；同步本地既有实现后回归通过，权限与执行断言保留。
- CLI 定向回归覆盖 core 9 文件 338 项、bootstrap 10 文件 250 项、adapters 2 文件 50 项、contracts 7 项、CLI node:test 194 项，共 839 项。core 首轮 1 项文案不匹配，修正后重跑所在文件 54 项通过；CLI 最终 194/194。CLI node:test 最初误用 Vitest，随后按 package.json 的 Node runner 重跑，不把空套件当通过。
- 打包裁剪与远控认证夹具工程测试 2 文件 12 项通过；受影响工程选择 158/158，按仓库规则跳过全量，不计作执行通过。
- 共享审批与卡片浏览器回归共 14 项通过，覆盖 390/1200px、深浅主题和键盘动作。8 份 conversation/plugin E2E fixture 检查通过；两份 settings 候选不在现有检查器支持范围，明确返回 unsupported，未修改门禁掩盖限制，E2E 类型检查覆盖其源码。
- Agent bundle 构建及暂存、Desktop production（复用 runtime assets）、Web、Server HTTP/remote 构建通过。大 chunk、动态 import 和插件耗时告警保留。
- 迁移运行时夹具使用实际 migration runner、完整基线 schema 和 9 条任务，覆盖嵌套父链、唯一目录、歧义目录、缺父、跨 Host、本地 NULL 及已归属行。只有预期 3 条远端任务的 project_id/判定位改变；14 张其他业务表逐表哈希不变，runner 创建表级备份，重复执行及重复迁移均幂等。未修改旧 migration SQL/checksum。
- 正常 Open-ZCode Dev 44.7.0 复用现有 profile 和资料：历史任务可见；真实 Provider 返回 `V3172_MERGE_OK`；单任务重启 RPC 成功，历史保留且续发返回 `V3172_RESTART_OK`。本轮验收任务归档，未修改原有任务。开发 React Scan 检查浮层曾拦截鼠标，关闭其检查/通知面板后交互恢复；未修改产品代码规避。
- 正常内置浏览器从地址栏打开 HTML，实际地址为 zcode-html，CSS、ES Module 和相对 JSON fetch 成功；隐藏 fixture 返回 403，原始 file fetch 拒绝。截图与运行记录留存在证据目录。
- 正常资料下从主导航插件管理点击既有 Sites 的打开按钮，返回根草稿并创建部署侧栏与真实 sandbox guest，没有新增聊天任务；面板显示需登录的提示。证明首发前打开链路可达，不代表联网部署、插件工具审批或首发 guest 提升已现场验收。
- UI 静态审计共 151 项（121 violations、30 unresolved），本次相对合并前修改行命中 0；不在上游合并中做整库 UI 重设计。新增规格与 lint 配置格式检查通过；README.md 只更新版本行，整体格式检查仍失败，使用合并前原文副本确认同样失败，保留原文不批量格式化。

未验证边界：真实手机、SSH/WSL/Docker、Windows/Linux 实机与签名安装包。本机自建产品服务未启动，联网目录刷新/官方 MCP 认证出现连接拒绝；不把缓存列表或 CLI 回归当作联网插件生命周期验收。不推送、不部署。
