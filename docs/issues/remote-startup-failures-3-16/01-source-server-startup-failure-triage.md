# 3.16.2 Source Server 启动阶段失败：工单分诊与修复记录

Status: in-progress

本次修复（诊断信息）已实施。下文“待决定与待补证据”中的问题仍未修复，等待产品决定或用户补充材料。

## 范围

- 工单：3.16.2 用户反馈中，连接日志走到 `[source-server:daemon] Starting Source Server` 之后失败的 26 条。
- 事故版本：`v3.16.2`（`2469e25346`）。远程链路从 3.16 起整体换成 R3 Source Server，3.15.x 升级上来的用户都是第一次在远端部署 Source Server。
- 修复目标：`hotfix/3.16.3` 线（本记录所在分支）。代码行号以该分支为准。
- 证据：工单描述里的最近 30 条连接日志；6 条工单带 ZIP 日志；本机 Docker 用 3.16.2 官方包的真实模块复现。原始资料不入库。

## 失败点

```text
Desktop ensureDaemon ── exec: zcode serve --daemon --json
  ▼
CLI runServe
  ├─ 已有 Supervisor 处于 starting → 直接当成功返回 port=null ─────────▶ [F] ingress port 无效
  ├─ SSH service 模式：写 unit → daemon-reload → enable --now ────────▶ [C] 注册失败（不回退 fallback）
  ├─ WSL/Docker fallback：fork Supervisor ─ 撞锁 exit 1 ──────────────▶ [B] exited before ready
  └─ 等待 ready（3.16.2 写死 10s）等不到 ───────────────────────────────▶ [A] Timed out waiting for Server ready
Supervisor：取锁 ─ launchCore ─ 等 Core ready（15s）
              │       ├─ Core 启动崩溃（如无 passwd 用户）
              │       └─ runtime/package.json 损坏 ─────────────────────▶ [D] run_main:92
              └─ 锁判活只看 PID，PID 复用后撞锁
Desktop
  ├─ readFile run/ingress-token ───────────────────────────────────────▶ [G] cat 失败
  └─ GET /api/server-info → token 与正在运行的 Core 不一致 ─────────────▶ [E] Server info invalid
```

## 逐类结论

| 类  | 工单                                                                                                                                                                                             | 根因                                                                    | 状态                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A   | ZCT-2112481920585723904、ZCT-2112460980290879488（Docker，同一用户）                                                                                                                             | 已确认：数字 UID 无 passwd 条目，Core 调 `userInfo()` 崩溃              | 已修复：`54a7e21c49`                                                                                               |
| A   | ZCT-2112914768197320704（WSL）、ZCT-2112775586956857344（SSH）                                                                                                                                   | 高概率：远端慢，3.16.2 的 10s 等待不够                                  | 已修复：`46b6a998f2`（等待改为 25s）                                                                               |
| A   | ZCT-2112917698278555648、ZCT-2112435343789551616（同一用户）、ZCT-2112851845933568000、ZCT-2112848580579258368、ZCT-2112590910155751424、ZCT-2112431540050116608、ZCT-2112389768754774016（SSH） | 证据不足，见 [05](05-unexplained-ssh-timeouts-and-token-read.md)        | 慢机与过期锁两个候选已覆盖；本次修复让后续工单带出 Core 失败原因                                                   |
| B   | ZCT-2112829415748423680、ZCT-2112594176134447104（WSL）                                                                                                                                          | 高概率：远端重启后锁的 PID 被复用，新 Supervisor 撞锁                   | 已修复：`e9c1bc2e8b`；旧格式锁的残留见 [06](06-legacy-lock-pid-reuse-after-upgrade.md)                             |
| C   | ZCT-2112890300914847744、ZCT-2112493484545282048、ZCT-2112467993947463680（后两条同一设备）                                                                                                      | 已确认机制：user manager 读不到刚写入的 unit 文件                       | 已修复（2026-10-23）：装载阶段失败回退 detached fallback，见 [02](02-service-registration-failure-fallback.md)     |
| C   | ZCT-2112838145302466560、ZCT-2112472098199756800（root，stderr 为空）                                                                                                                            | 证据不足                                                                | 同上                                                                                                               |
| D   | ZCT-2112751986554916864 等 4 条（同一次事故）                                                                                                                                                    | 已确认机制：已安装 release 的 `runtime/package.json` 损坏；损坏来源未知 | 已修复（2026-10-24）：同版本重装修复损坏副本 + 「重新安装远端服务」入口，见 [03](03-corrupted-release-recovery.md) |
| E   | ZCT-2112747431410888704、ZCT-2112410572815409152                                                                                                                                                 | 前者高概率为多台主机共享 home，后者证据不足                             | 待产品决定，见 [04](04-shared-home-across-hosts.md)                                                                |
| F   | ZCT-2112819424161320960                                                                                                                                                                          | 已确认：复用 `starting` 的 Supervisor 时以 exit 0 返回 `port:null`      | 已修复：`6e6dc621cd`                                                                                               |
| G   | ZCT-2112503947329736704                                                                                                                                                                          | 证据不足                                                                | 见 [05](05-unexplained-ssh-timeouts-and-token-read.md)                                                             |

## 本次修复：Core 启动失败原因被丢弃

### 根因

- 现象：Core 启动失败时，`serve --daemon` 只报 `Timed out waiting for Server ready`（service 模式）或
  `ZCode Server daemon exited before ready (code=1 …); check status.json for details`（fallback）。远端
  `status.json` 只有 `core exited code=1 signal=none`，远端也没有日志文件。上面 A 类 7 条 SSH 工单因此无法定根因。
- 首次出错：`supervisor.ts` 的 `handleTerminal` 在 Core 退出时用退出码覆盖了 Core 先前发来的 `fatal`。
  `cli.ts` 的等待失败分支也不读取本次启动写下的 `state` 与 `lastExitReason`。
- 复现（已复现，真实模块边界）：本机 Docker、`debian:bookworm-slim` arm64、3.16.2 官方 linux-arm64 包、fallback 模式。
  - uid 10001 无 passwd 条目：CLI 10.4s 后只报超时；`status.json` 最终为 `state: stopped`、
    `lastExitReason: core exited code=1 signal=none`，Core 报告的 `uv_os_get_passwd returned ENOENT` 不在任何地方。
  - 普通用户、`~/.zcode/v2` 不可写：同样的形状。
  - Supervisor 与等待代码从 3.16.2 到修复前的本分支没有变化，复现结论适用于修复前的本分支。

### 修复

- `supervisor.ts`：记录当前 Core 的 `fatal`，Core 退出时写成 `core exited code=1 signal=none: <fatal>`（截断到 500 字符，
  符合 status schema）。随 Core 作用域清空，重启后的 Core 不沿用上一个 Core 的原因。
- `cli.ts`：等待失败时，若本次启动写过状态，在原句后追加 `(state=…, last exit: …)`。启动前的旧快照不追加。
  错误首句、等待预算、退出码与回收行为不变。
- 错误类别不变：追加的原因可能含 `permission denied`、`ECONNREFUSED` 等文本，Desktop 按文本分类时会改报其他类别
  （本机 E2E 首轮实测改报为“没有远端写入权限”）。CLI 按原首句带公开码（超时 `remote-connection-timeout`、早退
  `remote-connection-unknown`），`transportAdapter.ts` 的 `ensureDaemon` 优先用该码，UI 标题与修复前一致。
- 规格：[r2 Server CLI 与 daemon](../../architecture/r2-server-cli-and-daemon.md) 的 `serve --daemon` 失败详情。

### 验证

- 单测：`supervisor.test.ts`、`daemonRegistration.test.ts`、`sourceServerTransportAdapter.test.ts` 新增 4 个用例，
  修复前全部失败，修复后通过；受影响单测 1452 个文件、16418 个用例通过。
- E2E：`conversation-session-ssh-remote-core-start-failure`（pending），修复前后对照见下方“本机 Docker 验证”。

### 残留

- Core 的 `fatal` 摘要超过 500 字符时，Supervisor 的 IPC schema 会整条丢弃。本次未改发送端，因为没有工单证据。

## 本机 Docker 验证

2026-10-22，macOS arm64 Desktop（E2E 构建）连接本机 Docker arm64 容器。SSH 目标用 `zcode-remote-ssh:test`
（ubuntu 22.04 + sshd，没有 systemd，SSH 走 detached fallback）；Source Server 为本分支构建的 linux-arm64 包。
环境变量按 `harness/remote/run-wdio-server.mjs` 的方式注入，用例保持 pending，未转正。

| 验证                                                              | 对应修复                              | 结果                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation-session-ssh-remote-core-start-failure`              | 本次修复                              | 修复后 PASS：错误为 `ZCode Server daemon exited before ready (code=1 signal=none) (state=stopped, last exit: core exited code=1 signal=none: EACCES: permission denied, mkdir [redacted-path])`，类别 `remote-connection-unknown`。修复前对照 FAIL：只有 `…; check [redacted-path]`，status 只有 `core exited code=1 signal=none` |
| `conversation-session-ssh-remote-daemon-starting-reuse`           | F：`6e6dc621cd`；版本头：`6800bdb696` | PASS：连接复用处于 starting 的同一个 Supervisor，等到 ready 后连上                                                                                                                                                                                                                                                                |
| `conversation-session-ssh-remote-install-killed`                  | 安装 shell 被杀：`02f8241f0c`         | PASS                                                                                                                                                                                                                                                                                                                              |
| `conversation-session-remote-restart-stale-daemon-ssh`            | B 与快照复用：`e9c1bc2e8b`            | PASS：接管残留锁，占用旧 PID 的进程不受影响                                                                                                                                                                                                                                                                                       |
| `conversation-session-remote-restart-stale-lock-docker`           | B（Docker transport）：`e9c1bc2e8b`   | PASS                                                                                                                                                                                                                                                                                                                              |
| `conversation-session-remote-workspace-folder-unresponsive-ssh`   | 远程目录无响应：`a91d52e62d`          | PASS                                                                                                                                                                                                                                                                                                                              |
| `conversation-session-r3-docker-transport`（只跑 R3A-TRN-01-UID） | 无 passwd 用户：`54a7e21c49`          | PASS                                                                                                                                                                                                                                                                                                                              |
| 0.25 CPU 容器冷启动（CLI 级，fallback）                           | 等待预算：`46b6a998f2`                | 3.16.2 官方包：一次 13.2s 报超时、daemon 15.1s 才 ready，一次 12.6s 成功。本分支两次都成功（16.2s、14.7s）                                                                                                                                                                                                                        |

未验证：systemd service 模式的 SSH、真实 WSL、macOS 远端、x64 远端（本机 amd64 模拟不可用）。

## 待决定与待补证据

- [02 service 注册失败是否回退 fallback](02-service-registration-failure-fallback.md)（2026-10-23 已决定并修复）
- [03 release 损坏后的恢复](03-corrupted-release-recovery.md)（已修复；损坏来源仍需现场材料）
- [04 多台主机共享 home](04-shared-home-across-hosts.md)（需要产品决定，证据不足）
- [05 SSH 超时与 ingress-token 读取失败的未知原因](05-unexplained-ssh-timeouts-and-token-read.md)（需要补材料）
- [06 3.16.2 旧格式锁在升级后的 PID 复用残留](06-legacy-lock-pid-reuse-after-upgrade.md)（需要确认是否改变既有取舍）
