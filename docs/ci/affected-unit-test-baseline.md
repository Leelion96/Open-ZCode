# 架构检查比较基线

App affected 单测入口已退役，原先与架构检查共用的默认分支选择函数保留在
`scripts/architecture/default-branch.mjs`。首次推送优先使用 `origin/staging`，随后是
`origin/HEAD`、`origin/main`、`origin/master`、`main`、`master`。

架构检查的实际基线选择和 push 门禁见 [pre-push 说明](../testing/pre-push-hook.md)。
不再提供 App 单测选择或全量回退。
