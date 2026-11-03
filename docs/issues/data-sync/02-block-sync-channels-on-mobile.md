# 02: 手机端禁止调用同步通道

Status: done

**Parent:** [数据同步：把本机配置推送到远端设备](../../remote/data-sync.md)

**What to build:** 手机远控通过桌面共享 Host 的 attachment，不能调用技能、MCP、插件同步通道的同步方法。手机端本来就没有同步 UI，但现在导入方法在 RPC 层仍然放行，只靠 UI 隐藏不足以阻止写入。桌面端的设置页和远程同步不受影响。

**Blocked by:** None (can start immediately).

## Acceptance criteria

- [x] 手机 `web-remote-replayable` attachment 的 RPC 白名单中不再包含技能、插件同步通道；调用时沿用未暴露通道的现有超时错误。
- [x] MCP 同步通道保留在手机白名单，按方法放行：只放行 `loadMcpFromUserDirectory`、`saveMcpToUserDirectory`、`listWorkspaceMcpServerStatuses`（手机 MCP 设置页在用）；其他方法（含以后新增的方法）返回 `feature_disabled`。
- [x] 桌面 `desktop-continuous` attachment 仍可正常调用这三个通道的全部方法。
- [x] 白名单策略处用中文注释说明原因：手机端没有同步 UI，只在 UI 层隐藏不足以阻止写入；MCP 通道混有配置方法，所以按方法放行。
- [x] 不改变手机端的 stream、snapshot、queue 和身份边界。
- [x] 如果 runtime 边界或远控文档列出了该白名单，同步更新（核对后只有 `docs/remote/data-sync.md` 描述该白名单）。
- [x] 先补测试再改代码。

## Verification

- Host 单测（沿用现有 attachment RPC 白名单测试）：手机 attachment 调用技能、插件通道被拒绝，MCP 同步方法返回 `feature_disabled`、三个配置方法可用；桌面 attachment 全部可用。
- 手机远控现有的回归单测通过。
