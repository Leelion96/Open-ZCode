# 产品隔离提交拆分

按以下四批提交，未推送。当前产品配置为 name、appId、三个隔离开关。

## 按依赖顺序提交

| 顺序 | 中文提交标题                            | 范围                                                                                                                                                           |
| ---- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `feat: 新增可配置的桌面产品基础`        | config/product.json、shared/product.ts 及公开导出、scripts/product-config.mjs、Desktop tsup/Vite 与桌面 Agent 构建注入、product-config.test.mjs、基础设计 spec |
| 2    | `feat: 隔离桌面应用身份与系统入口`      | 身份解析、Dev bundle、打包身份、协议注册/解析/回调生成、Finder/Windows/Linux 入口、Electron profile、安装清单和身份缓存                                        |
| 3    | `feat: 隔离用户级资料与内嵌 Agent 路径` | 数据根、启动设置、配置/凭据/数据库、全局资源、日志/导出、MCP 旧资料自动扫描限制、内嵌 Agent 用户目录候选及 Windows 数据目录保护                                |
| 4    | `feat: 隔离项目级配置与运行产物`        | 项目发现与读写、工作流/记忆/计划/分享、忽略规则、权限/监听、路径说明、动态工作流运行时 shared 依赖及 lockfile、完整集成验收与最终配置说明                      |

阶段 1 中 spec 应作为设计约定描述后续接入，最终“已实现/已验收”状态在阶段 4 更新。配置中的当前 appId 直接使用 dev.openzcode.app，不为早先未提交的 org 值单独做一次修改提交。

## 必须按改动块拆分的文件

| 文件或文件组                                                                  | 拆分方式                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| packages/services/src/paths.ts                                                | Windows 安装身份候选归第 2 批；用户根与 v2 复制路径归第 3 批                                                             |
| packages/desktop/electron-builder.config.js、build/installer.nsh              | 包名/清单/日志归第 2 批；自定义用户目录保护归第 3 批；生成 include 的公共接入随首个使用批次提供                          |
| adapters/src/skills/roots.ts、commands/roots.ts                               | 用户根取值归第 3 批；项目根取值归第 4 批                                                                                 |
| services 的 skills/commands/subagents/hooks/settings-sync/mcp-sync 等混合服务 | 用户路径归第 3 批；项目路径归第 4 批，不能整个文件提前提交                                                               |
| desktop/main/mcpUserDirectory/index.ts                                        | 用户配置根归第 3 批；workspace 配置根归第 4 批                                                                           |
| contracts/src/tools/saved-workflow.ts、bootstrap 的 script-workflow-\*        | global/user 路径归第 3 批；project/draft 路径归第 4 批                                                                   |
| ui/src/i18n/IntlProvider.tsx 及对应 locale 文件                               | 用户资料路径说明归第 3 批；项目忽略文件说明归第 4 批                                                                     |
| ui/src/lib/skillSourceFilter.ts                                               | 用户缓存/资源识别归第 3 批；项目资源识别归第 4 批；保留既有显式旧路径识别                                                |
| scripts/tests/product-*-isolation.test.mjs                                      | 公共测试工具与身份用例随第 2 批；用户资料用例随第 3 批；项目及跨用户/项目用例随第 4 批。公共工具位于 helpers/product-test.mjs，三类用例已分别拆成独立测试文件 |

同一文件新增的 import 必须与该批次实际使用的符号一起暂存，避免中间提交出现缺少导入或未使用导入。各阶段保持可编译；完成后执行对应验证。按用户要求，实际运行验收只验证三类全开，不执行关闭场景。

## 单独处理的资料

- specs/open-zcode-server/v1-api-requirements.md 是自建 server 的独立方案，可另行提交为 `docs: 梳理自建服务端接口需求`，不混入产品隔离四批。
- .agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml 的产品隔离种子可随第 4 批纳入。
- config/PRODUCT.md、product-isolation-verification.md 及本说明随第 4 批纳入，保持最终用户说明与完整实现一致。
- 未实现的品牌配置、类型和当前文档内容已移除。独立品牌盘点保存在本地忽略目录 .zcode-runtime/deferred-docs/application-brand-inventory.md，供后续恢复，不纳入提交。
- 构建产物、截图、Lint 对照副本、生成的 product.nsh 均不提交；.gitignore 中 product.nsh 的规则随相关安装器接入提交。

不要直接 git add 整个工作区。以文件清单加混合文件的改动块暂存，核对 staged diff 后再创建对应 commit。
