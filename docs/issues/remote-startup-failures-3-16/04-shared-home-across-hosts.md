# 多台主机共享 home 时 ingress token 被覆盖

Status: needs-info

所属：[01 分诊记录](01-source-server-startup-failure-triage.md) E 类。

## 现象

ZCT-2112747431410888704、ZCT-2112410572815409152：`Source Server registered with the remote OS user service manager` 后报 `Server info response is invalid`。

## 已确认的部分

- 失败形状：Desktop 读到的 `run/ingress-token` 与正在运行的 Core 不一致，Core 对 `/api/server-info` 返回 200 和匿名 body，
  Desktop 校验失败。
- 复现：两个容器挂同一个家目录卷、PID 命名空间独立，第二个 Supervisor 把第一个的锁判为 stale 并接管，它的 Core 覆盖了 `ingress-token`。
  docker 同内核下 unix socket 可跨容器连通，与真实跨主机不同，`serve --daemon` 的返回值一段按代码推断。

## 高概率但未证实

ZCT-2112747431410888704 的日志显示同一用户在两台集群节点上使用同一工作区路径，一台先成功、几分钟后持续失败，另一台一直报 F 类错误。
没有拿到“两台节点共享家目录”的直接证据。ZCT-2112410572815409152 没有 desktop 日志。

## 设计现状

- server root 默认只在本机使用：锁不记录主机（`packages/zcode-server-cli/src/runtime/lock.ts`），每次 Core 启动都覆盖同一个 `run/ingress-token`，
  `status.json` 与 `control.sock` 也在共享的 `run/` 下。规格没有共享 home 的约定。
- 本分支的锁进程身份（boot_id + starttime）在跨主机时同样判为 stale，行为与修复前相同。

## 需要的决定与材料

- 产品：是否支持多台主机共享 home（例如按主机分 run 目录或 server root）。
- 用户：确认两台主机是否共享家目录（`df -h ~`、`mount | grep " $HOME "`）。

## Comments

- 2026-10-26：server root 被替换的修复（[06 孤儿 Supervisor](../remote-tickets-3-16-2-1022/06-orphan-supervisor-after-server-root-replaced.md)）让 Supervisor 在锁被接管后停 Core 退出。共享 home 时，两台主机都把对方活着的锁判为 stale，被接管方曾以 1 退出，两边的 `Restart=on-failure` 轮流重启、互相接管，每 10～20 秒停一次 Core（同容器内用独立 PID 命名空间的第二个 user service 已复现）。现在锁换了 owner 时以 0 退出，不再自动循环，只剩最后启动的一方。两台主机在连接或登录时仍会互相接管，是否支持共享 home 仍待产品决定。E2E：`conversation-session-remote-shared-root-peer-host-ssh`（`--systemd`）。
