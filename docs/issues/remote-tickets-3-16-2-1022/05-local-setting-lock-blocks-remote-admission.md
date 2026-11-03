# 本机设置锁不能回收，远程连接准入失败并被误报为“连接超时”

Status: needs-info

所属：[01 分诊记录](01-ticket-triage.md)。工单：ZCT-2113066013935316992。行号以 `v3.16.2` 为准。

## 现象

Windows 用户连接 SSH 设备，4 次都在约 8s 报 `Timed out after 8018ms waiting for the ZCode file lock`，界面显示“连接超时”，阶段标签是 probe。同一会话里 `setting.update` 也 8s 锁超时，`getSnapshot` 两次约 8s。上一次会话同一路径 136ms 就连上了。

## 已确认的失败机制

```text
SSH 新连接 → connectSourceServerTarget（host/index.ts:1970）
 └─ manager.connect，membershipIntent ?? "add"（sourceServerConnectionManager.ts:348）
     └─ admitConnection（:826-831）→ intent=add → service.saveHost（remote-projects/connection-membership.ts）
         └─ SQLite 写 hosts → await changed()（remote-projects/index.ts:162-181）
             └─ publishProjectChange → settingService.update({})（services/src/node.ts:2162-2166）
                 └─ withAtomicFileLock(~/.zcode/v2/setting.json)（setting/settingService.ts:228）
                     └─ acquireFileLock 最多等 8s（fs/atomicFileUtils.ts:10）→ owner PID 被判“存活” → 超时
 └─ 文案含 “Timed out” → remote-connection-timeout → UI “连接超时”；阶段标签停在默认值 probe
```

- 锁是本机 Windows 的 `%USERPROFILE%\.zcode\v2\setting.json.lock`（目录锁）。不是远端锁，远端设备没有参与。
- 判活只看 PID：`shared/src/node/atomicFileLock.ts:55-62`（只有 `ESRCH` 算退出）、`:72-88`（锁年龄只对无 PID 的锁生效）。Windows 上 PID 被复用或进程无权打开（`EPERM`）都被当成存活，锁永久不回收。
- 释放失败被静默吞掉（`atomicFileLock.ts:218-224`）。
- 探针（真实 v3.16.2 `acquireFileLock`）：owner PID 已退出 → 2ms 回收；owner PID 存活或 `EPERM` → 8002ms 超时，文案与 cause `EEXIST` 与用户一致。限制：在 macOS 上模拟 `EPERM`，未在 Windows 上运行。

## 未知

锁的持有者（现有材料区分不了）：

- H1：上一会话残留的锁，其 PID 在 Windows 上被复用或无权打开。
- H2：当前 Main/Host 拿锁后释放失败（例如杀毒软件或索引器占用导致 `rmdir` 失败，失败被吞）。

## 设计缺陷（需确认后再改）

1. 锁判活只凭 PID，没有进程身份或租约（远端 `7c9139f8b0` 已用 boot_id + starttime 解决同类问题；Windows 可用进程创建时间），或对有 PID 的锁也设年龄上限。
2. 释放失败不记日志。
3. 连接准入依赖“旧字段设置投影”写入：SQLite 已提交，投影失败却让整次连接失败。SQLite 是唯一事实源，投影失败是否应降级为告警并重试，需要确认。
4. 本机锁超时不应归为 `remote-connection-timeout`，阶段标签不应停在 probe。

## 3.16.3 状态

未修复。`v3.16.2..HEAD` 没有改 `atomicFileLock.ts`、`settingService.ts`、`atomicFileUtils.ts`、`remote-projects`、`connectionErrors`；`e69dc8d551`、`7c9139f8b0` 修的是远端 server-cli 的锁。

## 待补（先不要删锁）

```powershell
Get-ChildItem -Force "$env:USERPROFILE\.zcode\v2\setting.json.lock"
Get-Content "$env:USERPROFILE\.zcode\v2\setting.json.lock\owner-*.json"   # pid、createdAt
Get-Process -Id <pid>; tasklist /FI "PID eq <pid>" /V; Get-Process ZCode
echo $env:HOME
```

PID 不是当前 ZCode 或启动晚于 createdAt → H1；PID 等于当前 Main/Host 且 createdAt 晚于本次启动 → H2。另问重启 ZCode 后是否恢复。

临时处理：从托盘完全退出 ZCode，确认没有 ZCode.exe，删除 `setting.json.lock` 目录后再启动。
