# 11: 钩子分类

Status: done

**Parent:** [数据同步：把本机配置推送到远端设备](../../remote/data-sync.md)

**What to build:** 用户可以在数据同步弹窗中把本机的 User 级钩子推送到远端，并在概览中看到钩子一行。

- 每条钩子定义作为一项，行内显示事件、matcher 和完整命令，让用户清楚知道将在远端执行什么。
- 推送时只把选中的定义合并进远端配置，远端已有的其他钩子和其他配置保持不变。
- 远端的钩子总开关只会被打开，不会被关闭。

**Blocked by:** [01: config.json 写入加固](01-harden-user-config-writers.md)、[09: 子智能体分类与新同步通道](09-subagent-category-sync-channel.md)

```text
对齐 key = 事件 + matcher + 类型 + 命令（process 类型再加 args，command 类型再加 shell）
内容哈希 = 其余字段（超时、async、状态文案、透传字段）的规范化结果；enabled 不参与
只差 enabled → 已同步；新建带来源 enabled，覆盖保留目标端 enabled
改了命令 → 视为新的一项
```

## Acceptance criteria

- [x] 在 09 新增的同步通道中实现 hooks category。
- [x] 只读取用户级 `config.json` 中的 `hooks`；`~/.agents/settings.json`、`~/.claude/settings.json` 中的只读来源不列出。
- [x] 对齐 key 和内容哈希按上面的规则计算；key 相同而内容不同时，显示「差异 · 内容不同」。
- [x] 每条定义的 `enabled` 按启用状态通用规则处理：不参与内容哈希；新建时带上来源的 `enabled`；覆盖时其余字段替换为来源，保留目标端的 `enabled`。
- [x] 写入时只合并到 `events[事件]` 中 matcher 相同的分组；其他钩子、其他 matcher 分组和其他配置字段原样保留。复用 01 加固后的严格读取和原子写入，不走设置页的保存接口。
- [x] 根级 `enabled`：只在来源开启时把目标打开，永远不把目标从开启改为关闭。
- [x] 行内说明显示完整命令；按设计稿不显示警告框。
- [x] 不同步工作区信任记录。
- [x] 中英文文案齐全。
- [x] 先补测试再改代码。

## Verification

- Seam ①：按 matcher 分组合并、保留其他字段、根级 `enabled` 只开不关、命令修改后成为新项、只差 `enabled` 判为已同步且覆盖后目标端 `enabled` 不变、只读来源不列出、损坏的配置拒绝写入。
- Seam ③：推送一条 PostToolUse 钩子，在远端配置中断言合并结果，并确认远端原有的钩子还在。

## Comments

- 2026-10-16 已知限制（decisions.md 第 22 条）：根级 `enabled` 只在本次推送有写入项时才会打开远端总开关；所有定义一致时无法通过弹窗打开。已写入 spec「Further Notes · 已知限制」，不新增 UI。
