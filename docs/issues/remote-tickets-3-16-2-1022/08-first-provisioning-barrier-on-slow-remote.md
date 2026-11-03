# 慢远端上首次 Provider Provisioning 屏障无截止，远程项目长时间打不开

Status: ready-for-human

所属：[01 分诊记录](01-ticket-triage.md)。工单：ZCT-2112962014687047680。行号以 `v3.16.2` 为准。

## 现象

macOS 用户从 3.15.3 自动更新到 3.16.2 后，SSH 远程项目“点不开”。日志显示：首次安装 13 分钟后报 `Timed out waiting for Server ready`；之后首次 Provisioning 用了 171s、80s，一次 95s 时连接关闭同步失败，最后一次 250s 以上未完成；期间 32 次打开被 Main 立即拒绝（“远程 workspace route 尚无可用 renderer attachment”）。

## 已确认：立即拒绝（bug，3.16.3 已修）

```text
首个请求：route 登记 → provisioning register → initialSync.then(attachRendererPort)
         （main/desktopRemoteSessions.ts:572-581；coordinator 无截止，首次失败即 throw）
后续 join：waitForJoinedRouteReady → waitForRendererAttachmentReady（:399）
         既无 pending 也无 attachment → :406-410 立即 reject   ← 首次出错点
```

- 日志：同步完成后 34～59ms attachment 就绪；被拒全部发生在对应首次同步完成之前。
- 探针：修复线单测原样通过；只把 Main 文件换成 v3.16.2 版本，2 个用例失败，报错与用户日志一致。
- 修复：`f47988d70e`（join 改为等待同一个首连结果，与发起者同成同败）。

## 设计问题（需要产品决定）

首次同步是发布屏障，没有截止、没有进度，失败会拆掉整个 session。规格 [Provisioning](../../remote/provider-provisioning.md) 明确“不增加重试、超时放行”。在这台远端上，修复后的 join 仍要等 80～250s 以上，连接一断仍一起失败。需要决定：

1. 首次 Provisioning 是否加截止与重试。
2. 是否显示同步进度。
3. 中途断开是否连带失败所有并发打开。

## 证据不足：远端为什么极慢

- 远端 home 在一个网络挂载路径下（`/media/<fs>/<user>`，推断为网络文件系统）；远程 `readTree` p50 16～19s（局域网用户约 0.1s），`prepareSession` 7～32s；一批 RPC 成批返回，符合远端事件循环被同步工作占住。
- 放大路径：`project/index.ts:281-306` 每次读取后对 N 个路径各调一次 `resolveWorkspace`；`host/index.ts:3880-3916` 每次新建 resolver；远端 workspace alias 仓库每次用同步 SQLite 开库。`a13711c127`（每连接只登记一次 identity）可降低负载，未在慢文件系统验证。
- 候选：网络文件系统 × 同步 SQLite × 侧栏连续刷新；远端出网受限；容器 CPU/IO 配额低。

## 风险

`9c555e6784` / `b7d49b4904` / `617231508b` 给打开目录加了 30s 截止。这台远端 RPC 常常 15～38s，可能把“慢”误报为“目录无响应”。需要在慢文件系统 harness 上验证。

## 待补

远端 `df -hT ~; findmnt -T ~`、`nproc; uptime; cat /sys/fs/cgroup/cpu.max`、元数据延迟循环测试、远端访问 ZCode 服务域名的耗时（`time curl -sS -o /dev/null <服务地址>`）；`localhost` 端口转发如何建立；连接面板安装日志与截图。

## 诊断建议

远端 RPC 耗时与 Provisioning 分阶段耗时进入反馈包；安装记录分阶段耗时；renderer 导航失败用 `logger.ts` 落日志（本次 renderer 没有记录导航失败）。
