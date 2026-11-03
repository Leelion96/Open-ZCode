# SSH service 注册失败后不回退 fallback

Status: done

所属：[01 分诊记录](01-source-server-startup-failure-triage.md) C 类。

## 现象

SSH 连接在 `Starting Source Server` 后报 `Failed to register service com.zhipu.zcode.server.<hash> (...)`，每次重试都失败。
5 条工单来自 4 个用户：

| 子类                                                      | 工单                                                                         | 根因       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------- |
| `enable --now` → `Failed to enable unit: Access denied`   | ZCT-2112890300914847744                                                      | 已确认机制 |
| `enable --now` → `Unit file … does not exist.`            | ZCT-2112493484545282048、ZCT-2112467993947463680（同一设备）                 | 已确认机制 |
| `systemctl --user daemon-reload failed (1):`，stderr 为空 | ZCT-2112838145302466560、ZCT-2112472098199756800（均为 root 用户，不同设备） | 证据不足   |

## 已确认的机制（修复前）

```text
探测 systemctl --user show --property=Version ── 成功（只证明 user manager 连得上）
  └─ 写 unit 到 server root ── daemon-reload 成功 ── enable --now
        └─ user manager 读 unit 文件失败（EACCES / ENOENT）── 抛错，不回退 fallback ── 每次重试都失败
```

- 探测：`packages/zcode-server-cli/src/platform/serviceManager.ts:176`。它不证明 manager 能读 server root。
- 不回退：`packages/zcode-server-cli/src/cli.ts:324-326` 明确规定“探测通过后注册失败必须返回根因，不能再用 detached fallback 掩盖”。
- 复现（arm64 ubuntu 22.04 + systemd 249 + sshd，真实 3.16.2 CLI）：
  - `~/.zcode` 指向只有某个组能进的目录，并在 user manager 启动后才把用户加进该组：输出与工单逐字相同的 `Access denied`。
  - user manager 使用私有 `/tmp`，`~/.zcode` 指向 `/tmp`：输出与工单相同的 `Unit file … does not exist.`。
- 用户实际是哪种环境（组变更、家目录在网络文件系统、manager 的挂载视图不同）未知。
- 这两类环境里，即使 unit 写到 `~/.config/systemd/user`，`ExecStart` 仍指向 manager 读不到的 server root，服务照样起不来。所以没有不改语义的局部修法。

## 产品决定（2026-10-23）

改为自动回退 detached fallback，并按注册执行到哪一步决定是否回退，不按 stderr 文案判断。这改变了原来“探测通过后注册失败不回退”的约定。规格见 [R3 §5.2 daemon 启动能力判定](../../architecture/r3-source-server-remote-architecture.md) 与 [R2 平台服务注册](../../architecture/r2-server-cli-and-daemon.md)。

```text
serve --daemon
  ├─ 已有存活 daemon（ready / starting）── 一律复用（同 root 旧 identity service 迁移除外）
  └─ 冷启动
       探测 Version ── 失败 ──► fallback（不变）
       └ 成功
          daemon-reload ─┬─ 失败 ──► fallback，连接日志带原始错误（新）
          enable <路径> ─┘
          start <unit 名> ── 失败 ──► 返回错误，不回退（不变）
```

1. 冷启动时每次重新选择启动方式，不持久保存 fallback 选择。环境修好后自动回到 systemd。
2. 存活的 daemon 一律复用。删除“空闲 fallback 停止后迁移到 OS service”；保留同 root 旧 identity service 的迁移。
3. systemd 注册拆成 `daemon-reload` → `enable <路径>` → `start <unit 名>`。装载阶段（前两步）失败时，本次没有启动任何 unit，直接回退；启动阶段失败时 unit 已启用，保持现状返回错误。
4. 不做：持久策略文件、新锁、systemd 状态查询、重试命令、回退前清理 unit。同一 root 只有一个 Core，由现有 `server.lock` 保证。

三类工单都在装载阶段失败（`enable` 两类、`daemon-reload` 一类），修复后都会回退并连上。空 stderr 子类的根因仍未确认，原始错误会进入连接日志。

只改 Linux systemd；macOS launchd、Windows Task Scheduler、WSL/Docker 的显式跳过注册保持不变。

## 待补证据（空 stderr 子类）

请用户在远端执行并回传：`id`、`type systemctl`、`systemctl --user status`、`journalctl --user -u 'com.zhipu.zcode.server.*' -n 50`。

## Comments

- 2026-10-22：ZCT-2112890300914847744 已在 `v3.16.2` 精确版本复核。探测、注册、不回退规则与报错文本的代码与本文一致（v3.16.2 不回退规则在 `cli.ts:322-324`，本文行号为 hotfix 线）；脱敏回放得到的文本与工单逐字一致。用户环境仍未知。见 [2026-10-22 批次分诊](../remote-tickets-3-16-2-1022/01-ticket-triage.md)。
- 2026-10-23：按上面的决定实施。systemd 注册拆成三步并标记失败阶段，`serve --daemon` 在装载阶段失败时回退 detached fallback 并输出 `serviceFallbackReason`，连接日志的 fallback 行带原因；存活 daemon 一律复用，删除空闲 fallback 迁移。单测覆盖三步调用、阶段标记、回退、启动阶段与无阶段错误不回退、存活 fallback（含运行任务、starting）复用。真实 systemd 249 + SSH 的桌面 E2E（R3A-BLD-08）三个子场景通过：组列表过期、manager 私有 `/tmp` 都连上并在日志带原因，重连与直接 `serve --daemon` 复用同一 Supervisor/Core；刷新组列表并停止后重连自动注册为 OS service；正常环境仍注册为 OS service。空 stderr 子类没有现场复现，根因仍未确认。
