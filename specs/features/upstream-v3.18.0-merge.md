# v3.18.0 合并边界

将上游 `b95ebaffeab641907b38652f45c1502bd762972d`（父提交 `a9fe401eede6e6e5e01be9048679c206fe6f02d9`）合入本地 `2f0679a8`。采用正常双亲 merge，保留 Open-ZCode 现有产品定制；本地完成提交，不推送、不部署，不修改 Server 仓库。

## 产品与实现规则

- 沿用 [v3.17.2 合并边界](upstream-v3.17.2-merge.md) 和既有五字段 `config/product.json`。保留品牌、身份、用户/项目资料隔离、自建可信更新源、普通公告、独立 Web、跳过登录及官方账号/套餐/Highspeed/遥测的现有裁决。
- 完整接入上游 Design 与浏览器设计工具、worktree、会话控制、扩展进程、语音输入、输入框编辑态、分享管理、永久删除、归档暂停定时任务、多语言及稳定性改动。保留上游功能开关默认值、平台限制和候选 E2E 状态，不恢复退役的 App 单测。
- 新增自有品牌文字沿用现有公共产品常量与 `{productName}` 插值，覆盖五种界面语言。用户、服务端、第三方内容与内部标识不改；不增加运行时品牌替换层。分享继续使用产品协议，下载和官网入口不回落上游。
- 新增本机用户/项目资料入口接入既有产品路径派生值，保留显式路径、环境变量和远端运行组件的原优先级。worktree 仍只是会话 cwd，不新增 workspace 或 CLI owner；共享兼容目录、远端组件、协议和原始用户数据不机械改名。
- 两份内置模型 JSON 采用上游 revision 44 完整增量，仅保留已裁决的官方账号 providerRules 与 builtinProviderModelRules 删除；普通 Provider 模板、排序、能力和用户选择保持上游规则。
- CLI 唯一持有会话事实、输入接纳和权限，Host 持有组织态与设备路由。永久删除、归档联动、凭据迁移复用上游权威入口和事务；不修改旧 migration/checksum，不新增绕过 owner/lease 的写入路径。
- 构建入口注入同一产品配置；新增扩展进程继续通过既有构建 defines 和受控环境白名单启动，保留上游原生依赖、权限、签名及证书校验。

```text
构建产品配置 → 品牌 / 身份 / 用户与项目目录 / 可信更新源 → Desktop / Web / Host / Agent
原项目 Host → worktree 创建与绑定 → 同项目 CLI → 会话 cwd 固定
CLI 会话事实与输入接纳 → Host 组织态与索引 → Desktop continuous / 手机 replayable
扩展进程 → Host 能力网关 → 原有会话 owner / 权限入口 → UI 插槽与视图投影
```

## 验收

- 检查全部冲突及自动合并的定制重叠路径，记录品牌、产品配置、模型目录、更新源和新资料路径的裁决。
- 使用 `mise.toml` 指定的 Node / pnpm；完成根 `pnpm typecheck`、`pnpm lint` 和 `pnpm architecture:check --changed`，如实记录 warning、已有失败和修复。
- 执行产品配置、路径隔离、构建配置及冲突涉及的工程/CLI 定向回归；CLI 改动按其当前 package scripts 完成 typecheck/lint。schema 和格式检查只使用当前仓库入口，不以历史结果代替本轮验证。
- 如需运行时验收，复用目标项目正常实例和现有资料；破坏性样本仅使用副本。未执行的 UI、真实手机/远程及跨平台验收明确列出，不宣称通过。

## 实施与验证记录

2026-11-11：解决 34 个冲突路径（31 个内容冲突、3 个修改/删除冲突）。README 保留 fork 说明并更新源码版本，功能图谱同时保留产品配置及新增永久删除节点；接受删除上游退役的 Node REPL 声明产物。其余冲突按新上游逻辑与既有产品常量融合，不整块回退旧凭据、登录或上下文实现。

- `config/product.json`、`config/default.json` 与合并前逐字相同；两份模型 JSON 结构严格等于上游 revision 44 仅清空两组官方账号规则，Terra 增量完整保留。普通公告无官方 token、官方套餐/加速卡关闭、自定义 Provider 导航、跳过登录、独立 Web 任务查询与自建更新源保持。
- 新 worktree 根、插件配置识别器和冷启动语言读取接回既有产品资料根，覆盖用户/项目隔离开关独立性；扩展进程名接入产品前缀并同步受控依赖。扩展授权与审计目录、系统凭据路径摘要复用上游实现；内部密钥库服务标识和远端组件路径保持兼容。
- 五种界面语言按消息 key 接入产品名称及实际路径；新增分享管理复用产品名称与协议，保留图标。修复中英字典此前误改的 `openInZCode` 消息 ID，保留新分区登录、凭据恢复和数据同步装配。

验证使用 Node 24.14.0 / pnpm 10.33.2，冻结 lockfile 安装成功。主体证据位于 `packages/desktop/.e2e-artifacts/upstream-3180-merge/`。

- 根 `pnpm typecheck` 通过，含 E2E 与 Renderer services 类型检查；根 `pnpm lint` 为 0 errors / 538 warnings，包含上游新增 Hooks 规则告警。架构检查 0 violations。首次架构检查发现扩展模块 manifest/policy 的 shared 依赖未同步，补齐后通过；未刷新架构 baseline。
- CLI 类型检查 34/34 tasks 成功；CLI lint 为 0 errors / 86 warnings，另保留 4 项原样上游行数诊断。嵌套 workspace 的 Turbo 通过现有根工具 bin 执行，未修改业务脚本。
- CLI 定向回归共 22 文件、553 个唯一用例：core 143、bootstrap 83、adapters 186、Node REPL 27、Sites Vitest 83、Sites Node 31。初次运行的旧 dist 导出缺失在依赖重建后消失；旧品牌及官方 CDN 预期按产品合同修正后定向复跑通过，市场数量 16 与权限/执行断言未放宽。此为首轮通过项与失败文件/用例复跑的合计，不宣称一次全量绿跑。
- 会话控制独立包 7 文件 103 项通过；构建配置、Hooks lint、退役测试与核心边界工程 22 项、keyring 资源 3 项、跨平台依赖裁剪/原生包策略 11 项、Windows runtime host 构建 3 项通过。schema 合同 8 项及两库兼容性检查通过。
- 自建更新源 Mac/AppImage/NSIS 共 33 场景通过，覆盖 501、断网、缺配置不回落官方和动态认证边界。证据分别为 `update-source-security-hC7arb`、`update-source-security-Tbmd6w`、`update-source-security-7PyXr6`（位于同一 `.e2e-artifacts/`）；签名和安装使用受控场景，不代表 Windows 实机发布验证。
- 独立 Web 既有浏览器回归 5/5 通过（`standalone-task-list`）。冷启动语言读取先复现原上游隔离失败，再以 4 种产品配置验证 20 项运行时断言，覆盖产品根、Home 优先级、新语言和旧字段兼容、损坏/缺失文件，证据为 `locale-product-bootstrap-dNFprR/results.json`。
- 新规格及受控入口格式检查通过。全合并 whitespace 检查保留上游 SSE fixture 的 EOF 空行；对比原上游提交可复现同一项，未改写测试数据。既有 README 的 Markdown 双空格换行保持原样。

未执行完整桌面 UI、真实手机/SSH/WSL/Docker、Windows/Linux 实机及签名安装包验收；不将类型检查、受控更新器或浏览器夹具等同于这些验证。本轮不修改用户资料或 Server 仓库，不推送、不部署。
