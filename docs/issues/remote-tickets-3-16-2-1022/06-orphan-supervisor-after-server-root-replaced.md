# server root 被替换后孤儿 Supervisor 写出 ready，Desktop 读不到 ingress-token

Status: done

所属：[01 分诊记录](01-ticket-triage.md)。工单：ZCT-2112854001415753728；合并样本：[启动分诊 05](../remote-startup-failures-3-16/05-unexplained-ssh-timeouts-and-token-read.md) G 类的 ZCT-2112503947329736704。行号以 `v3.16.2` 为准。

## 现象

SSH 连接日志在 probe 之后直接出现 `Source Server registered with the remote OS user service manager`（前面**没有** `Starting Source Server`），1s 内报 `Command failed (code 1): cat: [redacted-path]`，每次重试都一样。

## 机制（高概率，已复现）

```text
外部：daemon 运行时删除/替换 ~/.zcode/server（推断的触发条件）
  │  旧 Supervisor(S) 与旧 Core(C) 继续运行；旧 run/ 的 token/lock/control.sock 随目录消失
旧 S：每条 Core 消息（heartbeat 10s）→ 按路径 rename 写新 run/status.json(ready, pid=C, port=P)
Desktop 连接
  ├─ 本工单：probe 读 status.json，kill -0 C 成功 → observedReady → 跳过 serve --daemon
  └─ G 样本：重装 → serve --daemon → enable --now（unit 已 active，空操作）→ 等到旧 S 的 ready
ensureDaemon 打印 "registered…" → readFile run/ingress-token → 文件不存在 → 失败
```

- Desktop：`packages/server/src/source-server/transportAdapter.ts:376-378`（observedReady）、`:379-380`（只有不复用才打 Starting 并执行 serve）、`:398-408`（复用路径也打 registered）、`:409-412`（readFile token）。
- probe：`sourceServerProbe.ts:53` 只用 `kill -0` 判断 status 里的 Core pid。
- 写入：`runtime/statusSnapshot.ts:33-50` 只按路径写；`supervisor.ts:463-493` 每条 Core 消息都持久化；token 只在 Core 启动时写一次（`server-core/core.ts:58`、`ingressToken.ts:5-17`）；服务端只有 uninstall 删 token，且 uninstall 先停服务；Desktop 不调用 uninstall。
- CLI：`cli.ts:279-288` 只有 control socket 回应才复用；`serviceManager.ts:39` unit 名按路径哈希（重装后不变）、`:214` `enable --now` 不重启 active unit；`cli.ts:629-650` 只看 status.json。
- 复现（Ubuntu 22.04 + systemd 249，3.16.2 官方 linux-arm64 包，3/3）：`rm -rf ~/.zcode/server` 后重装，`serve --daemon` 返回删除前旧 Core 的 pid；`cat run/ingress-token` 不存在；`run/` 只有 status.json；`/proc/<pid>/exe` 显示 `(deleted)`。`systemctl --user restart` 后恢复。
- errno 被脱敏抹掉：v3.16.2 `sanitizeRemoteConnectionLog` 对 ENOENT/EACCES/EISDIR/ENOTDIR/EIO/ESTALE 都输出 `cat: [redacted-path]`（`shared/src/source-server/connectionLog.ts:44`、`:54`）。

## 未证实

用户是否删除或移动过 `~/.zcode` / `~/.zcode/server`。G 样本“1h18m 前 daemon ready → 之后 `bin/zcode` 消失需重装”是强旁证；本工单没有更早的连接记录，也没有 app 日志（当天主日志未进包，推断超过 8 MiB）。

已排除：token 未写完就 ready、状态过期 + PID 复用（token 仍在，症状是握手失败）、unit 的 HOME/ZCODE\_\* 不同（ExecStart 显式带 `--server-root`）、HOME 被启动输出污染（脱敏回放会留残留）。EACCES 可能性很低。

## 设计缺陷与需要的决定

端口与 token 来自两个没有代际绑定的文件；Supervisor 不确认自己仍拥有当前 server root；`serve --daemon` 在 service 模式只看 status.json。可选方向：

1. 端口与 token 同源并带代际（token 带 generation，或经 control socket 一次取得 `{port, token, generation}`）。
2. Supervisor 持久化前确认仍持有 `run/server.lock` 且 control socket 仍在；否则非 0 退出（触发 `Restart=on-failure`）。
3. CLI：service 模式 status 为 ready 但 control 不通时，用 restart 代替 `enable --now`，或明确报错。
4. 诊断：readFile 失败时在连接日志保留 errno 类别与 `status.pid`/`updatedAt`。

## 3.16.3 状态

已修复，采用方向 2，只检查锁，不另外检查 control socket（锁是 owner 的唯一事实源）。规则见 [R2](../../architecture/r2-server-cli-and-daemon.md)“运行中的 Supervisor 只在仍持有锁时写 `status.json`”。

- `557280ab05`：每次写 `status.json` 前读路径上的锁；锁不存在或换了 owner 时不再写，停掉 Core 后退出。E2E：`conversation-session-remote-server-root-replaced-ssh`（`--systemd`）。
- 后续修复：锁换了 owner 时以 0 退出，不触发服务管理器重启。只有锁不存在时以 1 退出。原因是共享 home 的两台主机会互相接管（[启动分诊 04](../remote-startup-failures-3-16/04-shared-home-across-hosts.md)），以 1 退出时两边轮流重启。E2E：`conversation-session-remote-shared-root-peer-host-ssh`（`--systemd`）。
- 仍未覆盖：旧版本启动的孤儿 Supervisor 不会自己退出，需要手动重启 unit（见下方“临时恢复”）；`crash-loop-stopped` 等没有 Core 消息的状态不写快照，不会发现失去 root。方向 1、3、4 未采用。

之前的提交：`62ba0eecd3` 只把复用时的文案改为 `Reusing running Source Server`；`7c9139f8b0` 只在握手失败时回退，`cat` 在握手之前抛出，回退后仍会拿到孤儿的 ready；`76edccb16a`、`e450176615`、`46b6a998f2` 不涉及。

## 待补与临时恢复

```sh
ls -la --time-style=full-iso ~/.zcode/server/run
P=$(sed -n 's/^[[:space:]]*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' ~/.zcode/server/run/status.json | head -n1)
readlink /proc/$P/exe; ps -o pid,ppid,lstart,args -p "$P"
systemctl --user show -p ActiveEnterTimestamp,MainPID 'com.zhipu.zcode.server.*'
```

`run/` 只有 status.json、exe 显示 `(deleted)`、unit 启动早于 `run/` 创建 → 本机制成立。临时恢复：`systemctl --user restart 'com.zhipu.zcode.server.*'` 后重连。
