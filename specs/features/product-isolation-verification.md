# 桌面产品隔离实施与验收

本轮范围：配置基础、应用身份、用户资料、项目资料。未更换应用内品牌文字或图标。按配置基础、应用身份、用户资料、项目资料四批提交，未推送。

## 结果

- config/product.json 仅包含名称、appId 与三个开关。默认 Open-ZCode / dev.openzcode.app；三类开关开启。
- 应用身份接入原有解析、打包与系统入口；协议注册、解析和 OAuth 回调生成统一使用 open-zcode。
- 用户根、固定 HOME 配置、可迁移业务根、全局资源、日志/导出和内嵌 Agent 用户目录候选使用 .open-zcode。显式路径和原有优先级不变。
- 项目配置、忽略、分享、工作流、草稿、计划、记忆、监听及相应校验使用自有目录。Hook 来源 kind 保留旧语义标识，不改业务协议/schema。
- 保留内部包名、兼容插件格式、通用 .agents / AGENTS.md，以及现有数据格式和状态所有者。没有自动导入或清理官方资料。
- 独立 CLI 构建不注入产品配置；桌面 Agent 构建注入。TUI 专属剪贴板实现不改，运行时始终覆盖的 OAuth 静态初值也不改。

## 执行过的验证

| 验证                               | 真实结果                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Node / pnpm                        | 使用 Node 24.14.0 和 pnpm 10.33.2；最初系统 Node 24.18.0 的尝试不作为最终版本依据                       |
| 根 pnpm typecheck                  | 通过                                                                                                    |
| 根 pnpm lint                       | 通过，70 warnings / 0 errors                                                                            |
| architecture:check --changed       | 通过，0 violations / 0 baseline / 0 new                                                                 |
| CLI 聚合 typecheck                 | 27/27 tasks successful；显式补充已有根 node_modules/.bin 到 PATH，未修改仓库检查规则                    |
| CLI 聚合 lint                      | 未通过，存在 max-lines 等存量诊断；本次修改的 CLI 源文件前后同规则比较为 7 项 / 7 项，无新增诊断        |
| 新增行为测试                       | 13/13；只使用三类全开配置，不执行关闭或单开场景                                                         |
| 内嵌 Agent 构建                    | 通过，产物暂存到本项目 bundled-agents                                                                   |
| Desktop build:no-runtime-assets    | Main/Host/preload/Scheduler 与 Renderer 构建通过；保留既有大 chunk 提示                                 |
| 实际 builder AppInfo               | 正式 org.openzcode.app、Open-ZCode、open-zcode-updater；协议 open-zcode；NSIS 宏与安装清单/数据目录一致 |
| 新增配置、实现、测试和说明文件格式 | 通过；没有格式化原有完整代码文件                                                                        |
| 全仓 fmt:check                     | 未通过，保留原有文件风格及其他本地资料，没有执行批量修复                                                |
| git diff --check                   | 通过                                                                                                    |

13 个用例覆盖配置派生及非法输入、正式/Preview/Dev 身份、链接解析、Finder 自有 workflow、技能根与 .agents、Hook 发现/显式旧配置、忽略规则真实写入、工作流权限边界、v2-only 复制、凭据路径、工作流保存/列出及失败回落、Electron 注册、Windows 注册表操作和 Linux desktop entry。破坏性哨兵只使用临时副本，未改写用户官方资料。

## 正常桌面实例

使用本项目 Electron 与由项目脚本准备的 Open-ZCode Dev.app，加载本项目 out/renderer。未使用测试 HOME、测试 userData 或空白测试身份。

- 独立 profile 位于系统 appData 下的 open-zcode-dev。
- 初始普通对话工作区位于 ~/.open-zcode/workspace/default。
- 首次正常引导后，设置写入 ~/.open-zcode/v2/setting.json；数据库包含 cli/db/db.sqlite 与 v2/tasks-index.sqlite。
- 通过 open-zcode://workspace/open 打开当前仓库，经原有信任确认后项目显示在正常侧边栏。
- 设置页实际显示 .open-zcode/v2 后缀；应用内品牌仍显示 ZCode。
- SDK 注册入口首次验收曾遗漏原有 zcode 字面量，已修复并补注册行为测试。验收期间错误接管的官方协议关联已恢复；最终系统查询确认 zcode 指向官方安装、open-zcode 指向本项目。
- 随包 Agent JS 使用本项目 Electron Node 启动，进程保持运行、无 stderr，stdio 输出 startup/storageState 通知。没有发送任务或模型请求。

## 已知验证边界

- 当前正常实例没有可用模型，界面提示配置模型；未进行登录或真实模型对话。这不属于本轮账号/服务端改造。
- Windows 注册表使用命令适配器模拟，Linux XDG 使用临时目录和命令适配器；没有在真实 Windows/Linux 执行安装或卸载。
- 没有实际发布、签名、公证或安装正式包；使用真实 builder 元数据与现有桌面构建验证。
- 品牌、Helper、远端组件、更新分发、外部连接、独立 CLI 安装发布不在本轮。
- 仓库其他本地资料（例如另一个 server 方案文档）保留，不计入本任务完成范围。

实测结束后 macOS 已锁定，未继续界面操作，也未尝试绕过系统锁定；此前的正常实例和界面验证结果已取得。

## appId 配置更新

appId 已从 org.openzcode.app 调整为 dev.openzcode.app，派生 Preview / Dev 标识为 dev.openzcode.app.preview / dev.openzcode.app.dev。上文首次桌面实测使用的是旧 appId，保留为历史记录；现有构建产物和已运行实例需重新构建/启动后才使用新值。

更新后验证：13/13 全开行为测试通过，根 typecheck / lint / 架构检查通过（Lint 70 warnings / 0 errors），实际 builder 配置的正式 appId 为 dev.openzcode.app。未重启或重新安装桌面实例。

产品配置已收缩为 name、appId 与三个隔离开关；移除了尚未实现的品牌字段及相关设计，其他隔离行为不变。
