# systemd user service 未开启 linger：断线后 Core、Agent 与任务一起被停止

Status: ready-for-human

所属：[01 分诊记录](01-ticket-triage.md)。工单：ZCT-2112831808419442688（无日志，机制已复现，本工单未证实）。行号以 `v3.16.2` 为准。

## 现象

用户反馈 SSH 容易断，每次自动重连后任务都不能恢复。截图里横幅写着 “Tasks already running on the device will continue”，当时正在跑 `nohup ./gradlew …`。

## 机制（已复现）

```text
远端（systemd 主机，SSH 走 service 模式）
sshd → logind 会话 → user@UID.service
  └─ com.zhipu.zcode.server.<hash>.service（Restart=on-failure，WantedBy=default.target）
       └─ Supervisor → Core → Agent CLI → bash → nohup gradle（同一 cgroup）
断线：ZCode 的 SSH 会话是该用户唯一会话 → 会话结束
  └─ 未开启 linger：10s 后 systemd 停止 user manager → 整个服务 cgroup 被终止（nohup 也保不住）
重连：新 SSH 会话 → user manager 重新拉起 → 全新 Core（新端口）→ 原轮次已中断，只能手动继续
```

- 单元定义：`packages/zcode-server-cli/src/platform/serviceManager.ts:66-71`；探测与注册：`:166-196`、`:212-214`。产品代码不处理 linger；唯一的 `enable-linger` 调用在验证脚本 `packages/zcode-server-cli/scripts/verify-remote-ssh.mjs:164`。
- 复现（Docker：Ubuntu 22.04 + systemd 249 + sshd，真实 3.16.2 包）：会话结束后 10.07s `Stopping User Manager`，随即 `Stopped ZCode Server`；注入服务 cgroup 的 `nohup sleep` 也被杀；停止后 status.json 仍写着 ready 与已死的 pid/port。

| 实验                    | 断开间隔 | 结果                        |
| ----------------------- | -------- | --------------------------- |
| 无 linger，只有一个会话 | 15s      | 被杀，重连后是新 Core       |
| 无 linger               | 5s       | 存活                        |
| 开启 linger             | 15s      | 存活                        |
| 无 linger，另开一个会话 | 15s      | 存活；该会话关闭 10s 后被杀 |

- 只有 Desktop 断开时任务不会中止（Core 的 WS 关闭只释放订阅，`server-core/http.ts:189-194`）；问题在于会话结束导致整个服务被停止。
- 与规格和文案矛盾：R3 主规格 REMOTE-03 假设 daemon 不依赖登录会话；横幅第三行 `remote.conversation.tasksContinue` 无条件显示（`RemoteConversationDisconnected.tsx:59`）。
- 附带发现：重连时 `serve --daemon` 与 systemd 自动拉起竞争，3 次中 1 次返回 `starting, port:null`（`76edccb16a` 已修），1 次 9.75s（贴近 3.16.2 的 10s 上限，`46b6a998f2` 已放宽）。

## 断线本身（证据不足）

keepalive 为 15s × 3（`packages/server/src/remote/sshAuth.ts:4-6`），约 60s 无回复才判死，回复由 sshd 处理，与 Core/gradle 负载无关，判定不算敏感。同版本带日志的同类样本都是先 `read ECONNRESET`、再 `connect ETIMEDOUT`；本工单反馈日志上传也报 `read ECONNRESET`。最可能是网络链路中断；远端 OOM（gradle 构建）是次要候选。

## 需要的产品决定

三选一（决定后同步改 R3 规格与 E2E）：

1. 注册 service 时自动开启 linger（需要确认权限与对远端系统的影响）。
2. 没有 linger 时回退 detached fallback。
3. 维持现状，但在 UI 如实提示，只在成立时显示“任务会继续”。

## 3.16.3 状态

未修复。没有任何提交处理 linger；`3f0aa63628` 只改 keepalive 断线文案；现有 E2E 容器没有 systemd，覆盖不到。

## 待补

断线当天导出日志；远端 `loginctl show-user $USER -p Linger -p Sessions`、`journalctl --user -u 'com.zhipu.zcode.server.*'`、`sudo journalctl | grep -E 'Removed session|Stopping User Manager|Out of memory'`、`free -h`；是否还开着其他 SSH/tmux 会话。判别实验：`sudo loginctl enable-linger $USER` 后重跑长任务并断网超过 30s，任务存活即证实。

## 验证要求

带 systemd 的 SSH E2E：断连超过 10s 后断言 Core 的 `startedAt` 不变、轮次继续。

## Comments

- 横幅在 busy 期间禁用了 Reconnect，正文仍写 “Reconnect to continue working.”，文案需统一（同类 ZCT-2112908912096673792）。
