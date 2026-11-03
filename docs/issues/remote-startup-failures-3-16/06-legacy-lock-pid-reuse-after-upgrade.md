# 3.16.2 旧格式锁在升级后的 PID 复用残留

Status: ready-for-human

所属：[01 分诊记录](01-source-server-startup-failure-triage.md) B 类，补充 `e9c1bc2e8b`。

## 现象

`e9c1bc2e8b` 让锁记录进程身份，身份不一致即判为 stale。3.16.2 写的锁没有身份字段，仍按 `kill(pid, 0)` 判定
（`packages/zcode-server-cli/src/runtime/lock.ts:231-249`）。远端重启后若旧 PID 落在同用户的其他存活进程上（例如本次连接的 shell 或 sshd 会话进程），
升级后的第一次连接仍会撞锁：fallback 报 `exited before ready (code=1)`，service 模式报超时，直到该进程退出。

## 已确认

探针（已复现，真实模块边界）：用本分支的 `DataRootLock`，写入 3.16.2 格式的锁 `{pid, acquiredAt, ownerToken}`，`pid` 指向同用户的无关存活进程，
`acquire()` 报 `Another ZCode Server instance is already running`。

## 为什么本次没有改

`e9c1bc2e8b` 有意保留这条规则：旧锁按 PID 判定，保证仍在运行的旧版 Supervisor 不会被新版抢占。改变它需要先确认取舍。

## 可选方向（待确认）

旧锁有 `acquiredAt`。持锁进程必须在取锁之前启动；若该 PID 当前进程的启动时刻晚于 `acquiredAt`，就是 PID 被复用，可判为 stale。
Linux 用 `/proc/<pid>/stat` 的 starttime 与 `/proc/stat` 的 btime 换算，macOS 用 `LC_ALL=C TZ=UTC ps -o lstart=` 按 UTC 解析（ps 按调用进程的时区输出）；读不到时维持现状。
