# Electron 44 Upgrade Implementation Plan

> **实施要求：** 按顺序执行，先证明回归失败，再修改最小实现并验证。

**Goal:** 升级到 Electron 44.7.0，按用户收口后的直接兼容风险与关键功能范围验收，并更新已有报告。

**Architecture:** package.json 拥有唯一版本。dev 与原生模块准备共享异步安装入口；Main 拥有截图和剪贴板 IPC。保留现有状态、协议与远端 Node。

**Tech Stack:** Electron 44、Node 24.14.0、pnpm 10.33.2、Vitest、WDIO、electron-builder。

---

### Task 1: Spec 与失败回归

规格：`docs/electron/electron-44-upgrade.md`。
修改 `packages/desktop/test/electronBuilderSecurity.test.ts`；新增 runtime 准备和图片复制测试。
扩展 `packages/desktop/scripts/mcp-apps-host-fixture/main.ts` 的原生复制回归。
运行定向 Vitest 与真实 Electron fixture，确认旧实现不满足新契约。

### Task 2: Runtime 与依赖

新增 `packages/desktop/scripts/ensure-electron-runtime.mjs`，接入 dev 与 node-pty 准备。
精确更新 desktop/package.json、lockfile、builder 和 Linux CI 版本读取。
安装目标运行时，记录实际版本并检查原生加载。

### Task 3: Clipboard 与兼容

迁移 pluginSandbox/host.ts 的 PNG 写入并更新 CONTRACT.md。
运行 Task 1 的回归；用真实 Electron 验证生产 IPC 和剪贴板。
按实际 runtime/typecheck 证据修复兼容阻塞，不增加未验证兜底。

### Task 4: 收口验证与交付

2026-10-14，用户要求缩小范围。以 `docs/electron/electron-44-upgrade.md` 的“收口验收范围”为准：运行时/依赖、剪贴板/IPC、原生模块/终端、单个核心会话代表链路、生产包/更新、macOS 下限六组。复用已有通过证据，不重跑根与 CLI 全量或 177 个桌面文件；不继续修正所有通用 E2E 失败、后台遥测和无关 pending。

此前全量、定向失败及通用测试改动保留为后续工作。Subagent 缓存、Browser 插件产物清理、权限 origin 和普通退出安装的产品修复保持独立范围。macOS 13+ 使用 44、12 保留旧版的边界不变。

只补选定链路的证据缺口，完成最终代码门禁和 diff 收口，再更新已有 HTML/飞书报告。已确认的 Electron 44 新回归必须关闭；共有失败和缺少环境的发布项目如实列明。满足本轮必要验证后提交升级相关改动；按此前授权更新以 staging 为目标的既有 Draft MR，不自动合入或发布。

### 最终收口结果

通用测试维护的 49 个文件已原样保存在 `test/electron44-validation-followups` 的工作区，键盘回放凭据修正从升级 diff 撤出。仅保留 Gen UI 真实夹具的异步剪贴板适配与 5 项回归，以及既有规格/计划更新。最终类型检查、Lint、架构检查和 12 文件 149 项直接单测通过；affected 因官方选择覆盖全根套件而按合同跳过，不计为新一轮全量通过。

生产包来源 `b1fdac4d12`；最终分支的产品代码、依赖和构建配置与该来源一致。复用原生模块、terminalService、显式 41→44 更新、macOS 下限、Gen UI 及核心会话代表链路的运行证据。历史全量与通用用例的失败记录保留，独立修复不混入升级范围。

## 完整验证中发现的适配项

Linux 上 Chromium 152.0.7977.130 的精确 ChromeDriver 下载返回 404。先增加同 build
可用补丁选择与离线缓存身份测试，再修改容器驱动预取。使用官方发布数据，实际选择
152.0.7977.82，并把安装器返回的真实路径传给离线 WDIO。保留精确驱动存在时的路径，
不跨 build 取其他版本，不绕过 pending 准入。

## 2026-10-15 剩余验证结果

历史 Gen UI 剪贴板 CR 已由 `0da54aa1e3` 修复，最新审阅确认；隔离工作区的 8 项
单测和完整真实 Electron 44 Gen UI 夹具再次通过，无新增产品改动。补充验证完成
Developer ID 签名及 strict/deep 校验、当前正式配置/发布清单查询，以及 41 存量
task/session SQLite 的完整行哈希对照。公证凭据未配置，未来 44 清单和旧系统强更
策略仍需发布验证。

Chromium profile 正向读取通过，直接共用 profile 降级到 41 时 IndexedDB 未知 schema
并被重建；恢复升级前备份后读取通过。此风险和回退边界已写入既有升级规格，不修改
产品迁移逻辑。数据库读取及合成 profile 验证不替代完整产品 UI 的历史恢复。

## 已确认的 IndexedDB 降级限制

2026-10-15，用户确认无法制作专用业务回退包，且不采用占用额外存储的 profile
复制方案。用户评估场景较少，决定本轮先不处理 IndexedDB 降级风险，不再追加专项
改造或验证；购买页和奖励页不纳入专项范围。此前保留 44 内核的业务回退包方案不再
执行，不新增备份、隔离、反向转换或自动清理逻辑。升级读取通过和直接降级失败的
证据继续保留，不宣称无损降级；具体边界以升级规格为准。

补充完成一个旧版任务在真实 Electron 44.7.0 签名生产包中的恢复：旧列表、真实点击、
原 session、用户消息与回复显示通过；刷新后相同 session 和历史文本的 DOM 断言通过。
副本中该会话的 message / part 内容与顺序保持一致。首次打开截图确认，刷新截图仍为
启动页，不计为刷新视觉验收；不扩大为全量历史迁移或真实供应商续发通过。
