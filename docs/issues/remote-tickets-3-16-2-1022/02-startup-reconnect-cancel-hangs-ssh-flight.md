# 启动重连取消后 SSH flight 永久挂起，设备一直“连接中”

Status: done

所属：[01 分诊记录](01-ticket-triage.md)。工单：ZCT-2112827425880723456。行号以 `v3.16.2` 为准。

## 现象

Windows 用户的一台 SSH 设备下 4 个项目都显示“连接中”，详情卡停在“连接设备 · 第 1/4 步 · 已用 25 分 54 秒”。用户当天重启 7 次（含换目录重装），每次都卡住。手动连接和取消都无效，只能重启 App。

## 已确认的机制

```text
启动重连 runStartupReconnectBatch（host/index.ts:4112-4128）
 └─ Promise.race([connect({signal}), 10s timer])（sourceServerConnectionManager.ts:434,451）
     └─ 10s 到：reject 外层 + abort（:462-465）            ← 只结束外层等待
         └─ abort → adapter.cancel → backend.dispose → client.end()（transportAdapter.ts:473-487；ssh-backend.ts:612-626）
             └─ ssh2 1.17.0：已收 banner（sawHeader=true）后 socket 关闭
                 ├─ 不 emit error（client.js:745-756 只在 !sawHeader 时报 “Connection lost before handshake”）
                 └─ 清掉 60s readyTimeout（client.js:806-818）
                     └─ ensureConnected 只监听 ready/error（ssh-backend.ts:198-199）→ 永不结束
 └─ flight 留在 connectFlights，只在 settle 后删除（:386-410）
     └─ 后续向导/项目行连接都 join：await existingFlight.promise（:371-372），无截止、不响应自己的取消
 └─ 设备状态停在 bootstrapping → 所有项目行“连接中”；计时从这次操作第一条日志起算
```

- 日志：16:18:12（+08:00）`startup reconnect timeout … transport=ssh phase=probe elapsedMs=10002` 是该设备最后一条相关日志；之后没有任何状态变化（每次状态变化都会出现一组 `getSnapshot`，此后一次都没有）；16:18:31 的向导连接 join 进去，16:18:53 取消只释放了等待者。下午没有一条 `[ssh] client error`（dispose 后错误被吞，`ssh-backend.ts:106-110`）。
- 复现（真实 v3.16.2 模块 + ssh2 1.17.0 Server）：认证延迟 30s、2s 时 dispose → `probeSourceServer()` 75s 后仍挂起；不取消 → 60s 正常报握手超时；认证完成后再取消 → 正常结束。
- 规格：r3 主规格 §7.1 规定启动重连单节点 10s、只试一次，超时后进入 `failed`，用户可手动重试；`transportAdapter.ts:478-479` 注释也写“后续手动重试可新建 transport”。实现与两者不符。

## 未知

- 远端 SSH 认证为什么下午每次都超过 10s（上午手动连接 8.3s、16.9s 成功）。需要用户 `ssh -vvv` 的分阶段耗时。

## 修复方向

1. `SSHBackend.ensureConnected`：认证完成前收到 `close`/`end` 时 reject；`dispose()` 让挂起的连接立即失败。这是首次出错点。
2. Manager：启动超时后等 flight 真正结束，或把它从 `connectFlights` 摘除；join 方要响应自己的 signal 并有截止。
3. probe 命令本身没有截止（认证通过后远端命令挂起同样会无限等待），补截止。
4. UI：info 级 `canceled` 尾部也要当终态（`connectionLog.ts:63-69`、`RemoteConnectionConnectingStep.tsx:132-133`），否则计时继续。
5. 10s 启动预算对慢认证主机偏短，是否调整属于产品决定，不在本修复范围。

## 3.16.3 状态

分诊时（2026-10-22）修复线未修复：`617231508b`、`b7d49b4904`、`9c555e6784`（前提是设备已 online）、`b7d7ddd3c8`（未走到握手）、`3f0aa63628`（只改文案）都不覆盖；origin/staging 与 origin/main 同段代码相同。之后已在本分支修复，见下文实施记录。

## 验证要求

- 单测：`ensureConnected` 在 banner 后 close 时 reject；启动超时后 flight 被摘除，后续连接新建 flight。
- E2E：真实 sshd 容器延迟认证超过 10s，覆盖“启动超时 → 设备 failed → 手动连接成功”，检查侧栏项目行与详情卡。

## 临时规避

设置 → 远程设备 → 关闭“启动时自动重连” → 重启 ZCode → 手动连接（手动连接有 60s readyTimeout）。

## 实施记录（2026-10-22）

- 修复（`packages/server/src/remote/ssh-backend.ts`）：`ensureConnected` 给在途连接登记一个失败出口，`dispose()` 立即让它失败（沿用 “SSH backend 已释放，无法重新建立连接”）并摘掉 ready/error 监听。manager 的现有 catch/finally 随之写回 `failed` 并移除 flight，之后的手动连接新建尝试。原 `handleReady` 中“释放后 ready 迟到”的分支已不可达，一并删除。
- 范围收窄：没有用 ssh2 的 `close` 事件判定“认证完成前被服务端断开”。同一 ssh2 Client 重连时，旧连接的 `close` 可能晚到，无法与本次尝试区分（单测“同一 backend 断线重连”实测回归）。该路径没有工单证据，作为残留风险保留。
- 未做：启动 10 秒预算是否调整（产品决定）；probe 命令自身的截止时间；info 级 `canceled` 的 UI 计时。均与本工单触发条件无关。
- 验证：
  - 单测 `packages/server/test/sshBackend.test.ts`「认证进行中释放 backend 时，在途连接立即失败」：本机真实 ssh2 Server，认证挂起时 dispose；修复前 3 秒内仍挂起，修复后立即失败。
  - E2E `conversation-session-ssh-remote-startup-reconnect-slow-auth`（pending，本机 Docker SSH linux/arm64，远端 PAM 延迟 50 秒）：修复后重启约 9.5 秒设备进入失败，点“重试”约 1 秒上线；还原修复后 25 秒内仍是“连接中”。证据 run 见覆盖矩阵 R3A-STARTUP-SLOW-AUTH。
