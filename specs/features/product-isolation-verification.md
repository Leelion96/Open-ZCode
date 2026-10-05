# 桌面产品隔离验收

规则以 [产品配置基础](product-configuration.md) 和 [应用品牌文字](application-brand-text.md) 为准。当前验收配置为 Open-ZCode / dev.openzcode.app，三个隔离开关全开；未验收关闭或单开场景，不能据此宣称这些场景通过。

## 验收清单

| 类别 | 验收要求 |
| --- | --- |
| 配置基础 | 五个字段校验、名称安全性及统一派生；Desktop 与内嵌 Agent 使用同一配置，未注入构建保留上游默认。 |
| 应用身份 | 正式/Preview/Dev 元数据与 Electron profile 独立；open-zcode 协议注册、解析、OAuth 回调生成及 Finder/Windows/Linux 入口归属一致，不接管官方协议。 |
| 用户资料 | 启动设置、业务数据根、凭据、全局资源、日志/导出与 Agent 用户目录候选使用自有根；显式路径优先级、程序来源顺序和 v2-only 复制范围不变。 |
| 项目资料 | 配置发现、忽略、分享、工作流、草稿、计划、记忆及相应读写、监听、权限、清理和失败回落使用同一自有位置；保留通用 .agents / AGENTS.md 与显式旧配置。 |
| 跨作用域 | HOME 同时作为项目时仍分别解析用户/项目作用域；保留 workspaceIdentity 和真实 workspacePath 的区别，不串用身份或数据。 |
| 桌面流程 | 正常引导写入自有设置与数据库，协议打开工作区沿用信任确认，界面路径与实际位置一致；内嵌 Agent stdio 启动及存储通知正常。 |

行为验证使用既有入口：

```sh
node --test scripts/tests/product-config.test.mjs scripts/tests/product-identity-isolation.test.mjs scripts/tests/product-user-isolation.test.mjs scripts/tests/product-project-isolation.test.mjs
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

同时执行目标 Agent 包现有类型/Lint 检查及桌面构建。检查实际注册、读写与权限行为，不以源码字符串命中代替验收，也不通过新增忽略或豁免掩盖检查失败。

## 验证边界

- 真实桌面复用项目正常实例、现有资料和登录状态，不创建空白测试身份；破坏性样本使用副本。应用品牌界面由用户验证。
- Windows 注册表及 Linux XDG 的适配器验证不等于真实平台安装/卸载；签名、公证、正式安装包和发布需单独验收。
- 当前资料没有可用模型时，启动及存储检查不等于真实模型对话通过，不为验收改写凭据或发起付费推理。
- Agent 全量 Lint 存在既有失败，必须区分基线与新增诊断；保留原源码风格，不进行整仓格式化。
- 独立 CLI/Web 发布、Helper、远端组件、更新分发和外部连接策略不属于产品隔离验收。
