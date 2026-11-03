# 3.16.2 远程连接工单分诊（2026-10-22 批次）

Status: ready-for-human

本批 12 条工单的分析已完成。下文“待决定与待补证据”中的问题仍未修复，等待产品决定、设计确认或用户补充材料。

## 范围

- 工单：ZCT-2112827425880723456、ZCT-2112831808419442688、ZCT-2112858863014739968、ZCT-2112962014687047680、ZCT-2112975518018420736、ZCT-2112854001415753728、ZCT-2112890300914847744、ZCT-2113066013935316992、ZCT-2112871370522476544、ZCT-2112917815194779648、ZCT-2113021923315200000、ZCT-2112984371086536704。
- 事故版本：全部为 `v3.16.2`（`2469e25346`），7 个日志包的 about.txt 与工单一致。本文行号以 `v3.16.2` 为准。
- 修复线：`hotfix/3.16.3`（`v3.16.2..HEAD`，84 个提交）。“已修复”只表示该提交在修复线上，不表示已发布。
- 证据：工单描述里的连接日志、7 个 ZIP 日志包、截图；v3.16.2 精确源码；真实模块边界探针与本机 Docker 复现。原始资料与逐单报告保存在本机取证目录，不入库。
- 与 [3.16.2 Source Server 启动阶段失败分诊](../remote-startup-failures-3-16/01-source-server-startup-failure-triage.md)（下称“启动分诊”）的关系：本批有 3 条落在启动分诊的 A/C/G 类，结论补充到该目录的 05 Comments；其余是新问题。

## 失败点总览

```text
用户操作（启动自动重连 / 侧栏项目 / 向导 / 设置页）
 └─ renderer：项目交接、向导、横幅 ───────────────────────────────▶ [04] WSL 过期失败被重新分类为 “Connection failed”
 │                                                               ▶ [03] 安装确认交接丢失 SSH 密码 → “SSH 认证失败”
 │                                                               ▶ [09] 远程设备设置页字号偏小
 └─ host：连接准入 → 设置投影写入 ──────────────────────────────────▶ [05] 本机设置锁不能回收 → “连接超时”
     └─ SourceServerConnectionManager：启动重连 10s 超时 → 取消 ─────▶ [02] SSH flight 永久挂起 → 一直“连接中”
         └─ transport：SSH 认证 ────────────────────────────────────▶ 认证失败（3 条，证据不足）
             └─ probe → ensureDaemon → 读 ingress-token ─────────────▶ [06] 孤儿 Supervisor 写 ready、token 已丢失
                 └─ serve --daemon → systemd user service ───────────▶ 启动分诊 C 类（Access denied）
                     │                                               ▶ 远端重启后持续 “Timed out waiting for Server ready”
                     └─ 无 linger：会话结束 10s 后 user manager 停止 ▶ [07] 断线后 Core/Agent/任务一起被杀
 └─ main：首次 Provider Provisioning 屏障 → renderer attachment ──────▶ [08] 慢远端上项目长时间打不开
```

## 逐单结论

| 工单                    | 平台         | 现象                                          | 根因状态                           | 结论                                                                                                                                | 3.16.3                                    | 记录                                                                                       |
| ----------------------- | ------------ | --------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| ZCT-2112827425880723456 | Win → SSH    | 4 个项目“连接中”，第 1/4 步 25 分钟           | 客户端机制已确认                   | 启动重连 10s 超时取消 SSH 握手；ssh2 在已收 banner 后被 `end()` 不发 error，`ensureConnected` 永不结束；后续连接都 join 进该 flight | 本分支已修（02）                          | [02](02-startup-reconnect-cancel-hangs-ssh-flight.md)                                      |
| ZCT-2112831808419442688 | Win → SSH    | 容易断，重连后任务不恢复                      | 证据不足（无日志）；R1 机制已复现  | 断线：网络中断旁证；任务丢失首选 R1：systemd user service 无 linger，会话结束 10s 后整个服务 cgroup 被杀                            | 未修复                                    | [07](07-systemd-user-service-without-linger.md)                                            |
| ZCT-2112858863014739968 | Win          | 远程设备设置页字小                            | 已确认（代码）                     | 该页行标题 12px、行说明 10px；共享 `SettingsRow` 均为 14px；偏离 DESIGN.md 角色                                                     | 未修复                                    | [09](09-remote-devices-settings-typography.md)                                             |
| ZCT-2112962014687047680 | mac → SSH    | 更新后远程目录点不开                          | 高概率                             | 远端极慢，首次 Provisioning 80～250s+；3.16.2 在此期间立即拒绝重复打开（32 次）                                                     | 立即拒绝已修 `f47988d70e`；屏障无截止未修 | [08](08-first-provisioning-barrier-on-slow-remote.md)                                      |
| ZCT-2112975518018420736 | mac → SSH    | `Timed out waiting for Server ready` ×19      | 证据不足（候选收窄）               | 远端两次 TCP 不可达（推断整机重启）后再未 ready；H1 重启后锁 PID 复用（倾向）/ H2 Core crash-loop；已排除慢机                       | 部分覆盖                                  | 本文 §A 类新样本                                                                           |
| ZCT-2112854001415753728 | mac → Ubuntu | 复用 ready 后 `cat` ingress-token 失败        | 高概率（机制已复现）               | daemon 运行时 server root 被删除/替换；旧 Supervisor 按路径写 ready，token 已随旧目录消失                                           | 本分支已修（06）                          | [06](06-orphan-supervisor-after-server-root-replaced.md)                                   |
| ZCT-2112890300914847744 | Win → SSH    | `systemctl --user enable --now` Access denied | 机制已确认                         | 启动分诊 C 类；本次在 v3.16.2 精确版本复核了代码与脱敏文本                                                                          | 未变（设计取舍）                          | [启动分诊 02](../remote-startup-failures-3-16/02-service-registration-failure-fallback.md) |
| ZCT-2113066013935316992 | Win → SSH    | probe 阶段等文件锁 8s 超时                    | 失败机制已确认；锁残留原因证据不足 | 本机 `~/.zcode/v2/setting.json.lock` 不能回收（只凭 PID 判活）；连接准入写设置投影失败 → 误报“连接超时”                             | 未修复                                    | [05](05-local-setting-lock-blocks-remote-admission.md)                                     |
| ZCT-2112871370522476544 | Win → SSH    | SSH 认证失败（约 5s）                         | 证据不足                           | 倾向服务器拒绝真实密码（同设备 3.15.1 有相同 4s 级失败）；缺陷 A 可能性低                                                           | —                                         | 本文 §认证失败                                                                             |
| ZCT-2112917815194779648 | Win → SSH    | SSH 认证失败（约 9s）                         | 证据不足                           | 倾向真实凭据被拒 + 服务端失败延迟（错误密码、2FA、慢 PAM）                                                                          | —                                         | 本文 §认证失败                                                                             |
| ZCT-2113021923315200000 | Win → SSH    | SSH 认证失败（约 1s）                         | 证据不足                           | 首要候选缺陷 A（安装确认交接丢失密码）；“服务器立即拒绝”同样相容                                                                    | 缺陷 A 本分支已修（03）                   | [03](03-install-confirm-drops-ssh-password.md)                                             |
| ZCT-2112984371086536704 | Win → WSL    | 只有“安装需要确认”却显示 “Connection failed”  | 呈现层已确认；Profile 分裂高概率   | 约 22 小时前的无码过期失败被重新分类为 unknown；迁移的无 user WSL Profile 与新 Profile 分裂                                         | B1/B2 本分支已修；D1 待决定               | [04](04-wsl-stale-failure-handoff-and-profile-split.md)                                    |

## A 类新样本：ZCT-2112975518018420736

- 这是启动分诊 A 类里第一个带 app 日志的 SSH 样本。它的形状与“慢机”不同：
  - 远端已运行多天，当天正常连接过；01:36～01:49、02:08～02:11（+08:00）两次 TCP 不可达，同期另一远端正常，问题在远端一侧。
  - 第二次恢复后 `serve --daemon` 连续 19 次超时，每次 13.8～15.9s；第一次只用 6.8s 却报“10s 超时”（CLI 用远端时钟计时），推断开机后 NTP 向前校时，支持“整机重启”。
- 已排除：慢机冷启动（service 模式下 Supervisor 不随 CLI 超时退出，ready 后会被复用）、无 passwd、首次迁移、fallback 模式（应报 `exited before ready`）、本机网络。
- 候选：
  - H1（倾向，bug）：重启后残留 `run/server.lock`，旧 PID 被其他进程占用。3.16.2 的 `runtime/lock.ts:135-143` 把 `kill` 成功、`EPERM`、`pid === process.pid` 都算存活。探针：3.16.2 三种情形都冲突；修复线只剩“同用户存活进程”冲突（启动分诊 06 残留）。
  - H2（设计缺口）：Core 连续崩溃，Supervisor 进入 `crash-loop-stopped`（存活、持锁、不写 status）；`cli.ts:279-307` 只复用 ready/starting，`enable --now` 无效，10s 超时。规格未规定此时 `serve --daemon` 的行为。
- 3.16.3：`76edccb16a` 修了 01:50 那一次 F 类；`7c9139f8b0` 部分覆盖 H1（远端需先升级）；`46b6a998f2`、`e450176615` 对 H1/H2 无效（两种情况下本次启动都不写 status）。
- 分诊建议：平台把它作为 687 条“SSH连接失败”的代表。按形状复核：第一次超时前有 keepalive 判死/握手超时（远端不可达），之后每次约 14～15s 持续失败 → 归为“远端重启后起不来”，不按“慢机”加长等待。
- 待补：远端 `uptime -s`、`last -x reboot`、`ls -la ~/.zcode/server/run/`、`cat status.json server.lock`、锁 pid 的 `ps`、`systemctl --user show 'com.zhipu.zcode.server.*' -p ActiveState,SubState,Result,NRestarts`、`journalctl --user -b -u 'com.zhipu.zcode.server.*' -n 80`。journal 中 `Another ZCode Server instance is already running` → H1；`crash budget exhausted` → H2。

## 认证失败（3 条，无日志）

- 文案只有一个来源：ssh2 `level=client-authentication`（`packages/server/src/remote/sshAuth.ts:72-80`），即服务器拒绝了本次提供的全部认证方法。它不区分“密码错”和“客户端没带密码”。
- 规模：3.16.2 全部 2118 条工单中只有 4 条带此文案（全部 Windows；3.16.2 工单整体 74% 是 Windows，不构成平台信号）；3.15.3 拉取的 5000 条中有 5 条。“同类聚集 678 条”是模块整体聚类，不是本错误的数量。
- 同类带日志样本 ZCT-2113085028132474880 **已确认** 是缺陷 A，见 [03](03-install-confirm-drops-ssh-password.md)。
- 耗时能部分区分：缺陷 A 只试 `none`，耗时约等于握手；错误密码会试 `none`→`password`→`keyboard-interactive`，耗时含服务端失败延迟。≥4s 基本说明客户端提交了凭据；≤1s 无法区分缺陷 A 与“服务器立即拒绝”。
- 3.16.3：`57b1af9e1d`、`54bfa36560`、`4d2039642d` 只把 2FA 改报为“服务器要求额外验证”；`70cb10602b`、`1e58d74c03` 只处理凭据无法解密（不产生本文案）。都不覆盖缺陷 A。
- 待补（三条通用）：当天复现并附诊断日志；报错前是否点过“安装并继续”、从哪个入口发起、密码还是私钥；`ssh -v` 的 `Authentications that can continue:` 行；远端 `journalctl -u ssh -u sshd -n 50`（只有 `[preauth]`、没有 `Failed password` → 客户端没带凭据）。
- 诊断建议：认证失败时把 ssh2 实际尝试的方法和 `confirmSourceServerInstall` 写进连接日志（不含 secret）。
- 旁路发现：加密私钥口令错误时，ssh2 在 `connect()` 内同步抛 `Cannot parse privateKey`，`ssh-backend.ts:200` 直接 reject 原始错误，绕过了 `sshAuth.ts:97-102` 的口令文案归一化。

## 横向发现

- 诊断信息丢失是多数“证据不足”的共同原因：连接日志脱敏把 `cat` 的 errno、` failed (1)` 一并吞掉（`packages/shared/src/source-server/connectionLog.ts:44`、`:54`）；Desktop 不记录 probe 摘要与启动模式；挂起的 RPC 不留日志；renderer 不记录向导入口与主按钮点击。
- 多个问题来自“同一事实两处解析”：Renderer 与 Host 各自解析 Profile/凭据（[03](03-install-confirm-drops-ssh-password.md)、[04](04-wsl-stale-failure-handoff-and-profile-split.md)）；端口与 token 来自两个无代际绑定的文件（[06](06-orphan-supervisor-after-server-root-replaced.md)）。
- 锁判活只凭 PID 的问题同时出现在本机设置锁（[05](05-local-setting-lock-blocks-remote-admission.md)）与远端 server lock（A 类新样本 H1）。

## 待决定与待补证据

- [02 启动重连取消后 SSH flight 永久挂起](02-startup-reconnect-cancel-hangs-ssh-flight.md)（已修复，见实施记录）
- [03 安装确认交接丢失 SSH 密码](03-install-confirm-drops-ssh-password.md)（已按最小修法修复；Host 统一解析凭据仍是设计债）
- [04 WSL 过期失败交接与 Profile 分裂](04-wsl-stale-failure-handoff-and-profile-split.md)（B1/B2 已修复；D1 Profile 分裂需要产品决定）
- [05 本机设置锁不能回收导致远程连接失败](05-local-setting-lock-blocks-remote-admission.md)（需要用户补充材料 + 设计确认）
- [06 server root 被替换后孤儿 Supervisor 写出 ready](06-orphan-supervisor-after-server-root-replaced.md)（设计缺陷，需要产品决定）
- [07 systemd user service 未开启 linger](07-systemd-user-service-without-linger.md)（设计缺陷，需要产品决定）
- [08 慢远端上首次 Provisioning 屏障无截止](08-first-provisioning-barrier-on-slow-remote.md)（设计，需要产品决定）
- [09 远程设备设置页字号](09-remote-devices-settings-typography.md)（需要设计确认）
- A 类新样本（本文 §A 类新样本）与认证失败 3 条（本文 §认证失败）：需要用户补充材料。

## Comments

- 2026-10-22：02、03、04（B1/B2）已在本分支修复，单测与本机 Docker SSH E2E 的修复前后对照见各票实施记录与覆盖矩阵 R3A-STARTUP-SLOW-AUTH、R3A-LEGACY-INSTALL-HANDOFF。
- 2026-10-22：新观察（未处理）。迁移的旧项目首次安装上线后，向导打开原项目报 `project.not-found`。E2E 新容器没有该旧 workspace 的会话，属夹具差异；但形状与 ZCT-2112984371086536704 在 03:06 的“会话释放、未绑定原目录”相同，需要在带真实 3.15 远端数据的环境确认是否为产品问题。
- 2026-10-22：B1 第一版在线路未识别时忽略全部失败记录，造成普通失败后每次点击都静默重拨（违反项目导航规格 §2.2）。已修订为失败记录保存错误码、按码区分普通失败与等待点，见 [04 实施记录（B1 修订）](04-wsl-stale-failure-handoff-and-profile-split.md)。
