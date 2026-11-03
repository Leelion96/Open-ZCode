# 13: 模型提供商只读分类与失败重试

Status: done

**Parent:** [数据同步：把本机配置推送到远端设备](../../remote/data-sync.md)

**What to build:** 数据同步弹窗新增只读的「模型提供商」分类和概览行。

- 分类列出本机 Personal Layer 中的提供商（名称、端点、模型），API Key 用掩码显示。
- 自动下发依赖 lane。本机打开该设备上的项目时，lane 才存在。
- 设备有 lane 时，分类顶部显示最近一次自动下发的时间和结果。最近一次失败时显示失败原因和「重试」，用户点击后重新执行一次自动下发，不用等下一次自动触发。
- 设备没有 lane 时，分类顶部显示「打开该设备上的项目后自动同步」，不提供重试。
- 本分类不能勾选，也不参与「推送全部」。模型配置仍以本机为准，整包自动下发（R3 路线 A）。

**Blocked by:** [04: Tracer：数据同步页与技能推送](04-data-sync-page-skill-push.md)

```text
Renderer 分类页 ──读取──▶ 本机 Host ──▶ Main Provisioning 协调器
                                         （按 lane 在内存中保留最近一次结果）
        │                                 ├─ 有 lane：返回最近一次结果
        │                                 └─ 无 lane：返回「无 lane」
        └── [重试]（仅有 lane 且失败）──▶ 本机 Host ──▶ 协调器：同一条 single-flight lane，尾随同步
```

## Acceptance criteria

- [x] Main 的 Provisioning 协调器按 lane（Environment key）在内存中保留最近一次执行结果（时间、状态、无 Secret 的失败原因），按 sourceServerId 查询，并经本机 Host 提供给 Renderer。设备没有 lane 时返回「无 lane」。不新增持久化；结果只在本机流转，不进入远程 workspace RPC 合同，也不进入手机白名单。
- [x] 设备没有 lane 时，分类顶部显示「打开该设备上的项目后自动同步」，不显示结果，也不显示「重试」。不新增无项目时的下发链路，不为 source-settings 连接注册 lane。
- [x] 「重试」只在设备有 lane 且最近一次失败时出现，复用协调器现有的 single-flight lane 和 generation 尾随同步，不新增第二条同步链路，不增加自动重试或超时放行。
- [x] 列表只读，不能勾选。数据同步页不显示 API Key 明文：前端用掩码显示，不新增 Host 侧的掩码视图。
- [x] 顶部说明文案为「模型配置以本机为准，保存后自动同步到远端；API Key 和登录态随配置同步」。
- [x] 概览中本行的勾选框不可用；最近一次失败时「差异」列显示「同步失败」，其他情况显示「自动同步」；「推送全部」不包含本分类。
- [x] 修订 R3 主规格 §8.3（失败时用户可以触发重试，是「没有用户触发的同步入口」的唯一例外）和 Provider Provisioning 规格（包括其中「不新增 Environment 错误状态和设置页入口」的描述）。
- [x] 中英文文案齐全。
- [x] 先补测试再改代码。

## Verification

- 协调器单测：最近结果按 lane 记录，可按 sourceServerId 查询；没有 lane 时返回「无 lane」；重试与自动触发并发时只走同一条 lane，并产生一次尾随同步。
- Seam ②：成功、失败、进行中、无 lane 四种状态的展示；重试按钮只在有 lane 且失败时出现；Key 掩码；概览行不可勾选。
- Seam ③（本机 Docker 远端 runner）：先打开该设备上的一个项目，再用 docker exec 把容器内的 Provider 配置目标目录设为只读，保存一次本机模型配置，制造下发失败；恢复可写后在分类中点「重试」，断言容器内配置已更新、状态变为成功。
