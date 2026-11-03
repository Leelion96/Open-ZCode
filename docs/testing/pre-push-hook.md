# Pre-push Hook

Husky 的 `.husky/pre-push` 使用当前 PATH 中的 Node / pnpm，执行 `pnpm verify:pre-push`。
不强制依赖 mise，也不自动安装工具、stash 工作区或跳过失败检查。

```text
Git push ref 输入 → 清理 Git local env → 工作区与目标检查
                                      → 远程目标清单一致性 → lint → 过时文档措辞 → schema → 架构工具测试 → 变更架构检查 → 受影响工程测试
```

- 已暂存、未暂存或未跟踪修改均阻止 push；忽略 Git 已忽略的文件。
- hook 每个非删除目标先解析为 commit，再与当前 HEAD 比较；附注标签可以指向 HEAD；删除 ref 可通过目标检查，多 ref 逐项校验。
- hook 继续通过 ZCODE_PRE_PUSH_STDIN 传递 ref 和 SHA，架构检查与工程测试使用真实推送基线。
- 架构基线优先级：显式参数或环境变量、CI 变量、push remote SHA、upstream merge-base、
  默认分支 merge-base、HEAD。首次推送优先 origin/staging。具体实现见 scripts/architecture/git-base.mjs。
- 无效的显式架构基线仍失败。工程测试保留 remote SHA / 首推 staging merge-base / 手动 upstream 的基线语义；无效基线不能静默跳过。
- Git local env 必须先清理，避免工程测试的临时 Git 仓库误操作当前仓库。
- 过时文档措辞检查（`pnpm docs:stale-phrases:check`，`scripts/check-stale-doc-phrases.mjs`）：规则改了以后，旧说法常留在复述这条规则的其他文档里。脚本登记已作废的说法，扫描 `docs/` 与 `apps/zcode-cli/docs/` 的 Markdown，出现即失败并指向现行规则；`docs/plans/`、`docs/v4-refactor/` 是历史记录，不检查。改规则时把旧说法加进登记表。
- 远程目标清单一致性检查（`pnpm check:e2e-remote-targets`）直接比较内部队列声明与公开 JSON，不依赖 affected 的 import 图。只有私有 harness 目录不存在时跳过；有队列时清单缺失、损坏或漂移均阻止 push，且检查不改写文件。
- 任何检查失败均阻止 push；工作区检查也可独立执行 node scripts/check-push-worktree.mjs。

## 测试边界

App 单测已按 [测试规格](unit-test-quality.md) 退役；不再提供根 test、test:unit、
test:unit:affected、test:coverage 或 lint-staged 测试入口。

- 工程 Vitest：pnpm test:engineering <文件>，精确清单见 scripts/engineering-test-files.json。
- 工程增量：pnpm test:engineering:affected --base <任务起点>；--dry-run 可预览官方依赖图选中清单。
  pre-push 使用 --scope push；仅选择 engineering 项目，CLI/CUA 仍走独立入口。
  全量选择按既有规则报告跳过，不把跳过当通过；显式全量使用 pnpm test:engineering。
- 工程执行工具回归：pnpm test:engineering-tools。
- 架构及推送工具：pnpm test:architecture；schema：pnpm db:schema:check。
- Node 工程测试：按受影响文件执行 node --test。
- CUA：pnpm --filter @zcode/zcode-cua test；Agent CLI 按 apps/zcode-cli/AGENTS.md 执行。
- 桌面与浏览器验收保留既有入口及生命周期，不由工程检查代替。

工程 Vitest 使用独立进程串行执行真实 IO 测试，避免并发 Git、构建和原生模块互相干扰。
未执行、零收集、平台跳过或环境失败均不代表测试通过。日常只运行受影响工程测试，不默认全量。
