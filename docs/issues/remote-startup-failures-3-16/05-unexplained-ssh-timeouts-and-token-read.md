# SSH 启动超时与 ingress-token 读取失败的未知原因

Status: needs-info

所属：[01 分诊记录](01-source-server-startup-failure-triage.md) A 类（7 条 SSH）与 G 类。

## A 类：7 条 SSH 超时

工单：ZCT-2112917698278555648、ZCT-2112435343789551616（同一用户同一设备，持续超过 1 天）、ZCT-2112851845933568000、ZCT-2112848580579258368、
ZCT-2112590910155751424、ZCT-2112431540050116608、ZCT-2112389768754774016。

- 事实：都没有日志附件；从 `Starting Source Server` 到超时 11～14s，等于 3.16.2 的 10s 等待加前置开销。无 passwd 的修复不适用 SSH（sshd 登录需要 passwd/NSS）。
- 候选与覆盖：
  - 慢机冷启动：0.3 核 SSH 容器实测 Supervisor 19.2s 才 ready，3.16.2 报超时。已由 `46b6a998f2` 覆盖。
  - 过期锁导致每次启动撞锁：已由 `e9c1bc2e8b` 覆盖（旧格式锁残留见 [06](06-legacy-lock-pid-reuse-after-upgrade.md)）。
  - Core 启动崩溃：原因未知。本次修复后，连接错误会带出 Core 的 fatal 原因。
  - 首次启动迁移旧数据过慢（Core 在 ready 前执行 `migrateApplicationStorage`）：没有真实的 3.15 远端数据集，未验证。
- 为什么区分不了：3.16.2 的错误不带任何 Core 状态，远端也没有日志。
- 下一步：请用户升级到含本次修复的版本后重试，或回传 `cat ~/.zcode/server/run/status.json` 与 `journalctl --user -u 'com.zhipu.zcode.server.*' -n 50`。

## G 类：读取 ingress-token 失败

工单：ZCT-2112503947329736704。注册成功、status 已 ready 后，`ensureDaemon` 读 `~/.zcode/server/run/ingress-token`
（`packages/server/src/source-server/transportAdapter.ts:418`）报 `Command failed (code 1): cat: [redacted-path]`。

- 已排除：shell 启动输出污染 `$HOME` 解析。同一次连接的上传也用同一个缓存的 `$HOME` 解析 `~`，上传与解压都成功。
- 事实：token 由 Core 原子写入（临时文件 + rename），写完才报 ready；连接链路里没有删除它的代码。
- 缺口：客户端脱敏把 `cat` 的 errno 一起抹掉了，分不清“文件不存在”还是“没有权限”。
- 下一步：请用户回传 `ls -la ~/.zcode/server/run` 与 `id`。

## Comments

- 2026-10-22：A 类新增带 app 日志的样本 ZCT-2112975518018420736。形状是“远端两次 TCP 不可达（推断整机重启）后每次约 14～15s 持续超时”，已排除慢机；候选收窄为重启后锁 PID 复用与 Core crash-loop。见 [2026-10-22 批次分诊](../remote-tickets-3-16-2-1022/01-ticket-triage.md) §A 类新样本。
- 2026-10-22：G 类第二个样本 ZCT-2112854001415753728。机制已在真实 systemd 环境复现：daemon 运行时 server root 被删除或替换，旧 Supervisor 按路径写出 ready，token 已随旧目录消失。见 [06 孤儿 Supervisor](../remote-tickets-3-16-2-1022/06-orphan-supervisor-after-server-root-replaced.md)。
