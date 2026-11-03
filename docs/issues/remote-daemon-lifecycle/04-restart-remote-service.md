# 04 — 重启远端服务（端到端）

Status: done

## Parent

[01 — 在设备卡上停止和重启远端服务](01-stop-restart-remote-service.md)

## What to build

用户在设备卡「更多」菜单点击「重启远端服务」，确认后远端 Supervisor 与 Core 都换成新进程，设备自动回到“已连接”，
已打开的远程项目和会话挂回并可以继续发送。从已连接、未连接、连接失败状态都能发起；远端处于 `crash-loop-stopped`
时也能救回。合同见父票与
[R2 §8.1](../../architecture/r2-server-cli-and-daemon.md#81-stop---wait-与整棵进程树-restart2026-10-20)、
[R3 主规格](../../architecture/r3-source-server-remote-architecture.md) §7.1 与 §8.4.5。

- **远端 CLI**：`zcode restart` 改为由发起命令的 CLI 协调的整棵进程树重启：
  - daemon 在运行时，用 #02 的停止等待函数停止现有 Supervisor；未运行或 Supervisor 已死时跳过（残留锁按 stale 回收）；
  - 以 current release 执行 `serve --daemon` 并等待 ready，输出新 ServerStatus；
  - 保持原启动方式：OS service 继续由服务管理器托管，跳过服务注册的环境继续 detached fallback；
  - 能从 `crash-loop-stopped`、`stop-failed` 且 `pid:null` 恢复，新 Supervisor 重置崩溃预算；
  - control 超时返回 `source-server-control-unresponsive`；
  - 删除 Supervisor 控制协议中只重启 Core 的 `restart` 操作及其分支。
- **Transport Adapter**：非 SSH 执行 `restart` 时，与 `serve --daemon` 一样带跳过服务注册的环境变量。
- **Host**：连接管理器为生命周期操作 flight 增加 `restart` 类型。
  - 开始时清恢复定时器，设备显示“连接中”，不新增 Host 状态。
  - flight 存在时，在线连接关闭视为预期断线，只做连接失效、不排重试。
  - 命令成功后走现有连接流程并发出 reconnect，让 Registry 为已打开的 workspace 换代，最后移除 flight。
  - 失败时沿用更新失败的收口：原本有恢复意图且非终态时，从第一档开始自动恢复；否则为 `failed`。
  - 同一设备的更新、重启、停止互斥；显式断开和移除设备会中止进行中的重启。
  - 路由与凭据规则同 #03。
- **管理服务**：新增 `restartSource(sourceServerId)`，有严格 schema，只对桌面开放，并写设备操作日志。
- **设备卡**：在 #03 的分组中、「停止远端服务」之前加「重启远端服务」。可用状态与版本门禁复用 #03，确认弹窗和 toast 规则同 #03。

## Acceptance criteria

- [x] CLI 测试：分别从 ready、未运行、`crash-loop-stopped`、Supervisor 已死但残留锁四种状态执行 `restart`，最终都有新的 Supervisor 与 Core 处于 ready，崩溃预算已重置；跳过服务注册的环境下不注册服务；control 超时返回公开错误码且不 kill 进程；控制协议不再接受 `restart`。
- [x] Adapter 测试：WSL、Docker 下 `restart` 的命令带跳过服务注册的环境变量，SSH 下不带。
- [x] 连接管理器测试：重启期间在线连接关闭不排重试；命令成功后发起连接并发出 reconnect；从 online 发起的失败进入第一档自动恢复，从 offline 发起的失败为 `failed`；更新、重启、停止互斥；断开和移除设备中止重启。
- [x] 设备卡测试：「重启远端服务」的显示、禁用、隐藏与版本门禁同 #03；确认后调用 `restartSource`；成功与失败 toast 正确。
- [x] 桌面 E2E（R3 daemon 测试环境）：从设备卡「更多」重启后，Supervisor 与 Core 的 pid 都变化，设备回到“已连接”，已打开的会话可以继续发送。
- [x] case 目录与覆盖矩阵同步新增用例；手机端复用现有断线恢复用例，不新增。
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测通过。

## Blocked by

- [02 — 预备重构：统一“停止并等待”，泛化生命周期操作 flight](02-prefactor-stop-wait-and-lifecycle-flight.md)
- [03 — 停止远端服务（端到端）](03-stop-remote-service.md)

## Comments

### 2026-10-21 完成记录

- Commit：`ad37cd0289` feat(remote): restart remote service from device card
- 实现：CLI `restart` 由发起命令的 CLI 进程协调整棵进程树重启（统一停止等待 → `serve --daemon` 启动逻辑，错误分类与其一致），
  删除 Supervisor 控制协议的 `restart`；非 SSH `restart` 带跳过服务注册环境变量；Host `restart` 类型 flight、重启期间投影“连接中”、
  失效事件新增 `reason: "restart"`（Host wrapper 除 `profile-removed` 外按可恢复关闭）；管理服务 `restartSource`；
  设备卡「重启远端服务」，通用中断说明 key 改为 `settings.source.remoteServiceInterruptionDescription`（停止与重启共用）。
  Host 修两处竞态：远端命令返回后旧连接 close 可能未到，连接前先让旧连接失效；读离线路由凭据期间用户经另一条连接连上、
  随后删除重启所用连接时，从第一档自动恢复。两处均做了去掉修复后测试失败的变异检查。
- 验证：`pnpm typecheck`、`typecheck:e2e` 通过；`pnpm lint` 0 error；`pnpm architecture:check --changed` 0 violation；
  `pnpm test:unit:affected` 通过（1490 文件 / 16756 例，6 例跳过）；CLI 真实进程 `restartIntegration.test.ts`（ready、未运行、
  Supervisor 已死残留锁与 socket）与进程内 `cliRestart.test.ts`（`crash-loop-stopped`、`stop-failed` 且 `pid:null`、control 无响应、
  OS service 保持、控制协议拒绝 `restart`）、Adapter、Host（12 例）、设备卡测试通过；`e2e:fixture:check`、
  `pnpm audit:conversation-session-coverage` 通过；改动文件 `oxfmt --check` 通过；`check-competitor-terms` 0 处。
- E2E：`conversation-session-r3-restart-remote-service`（R3A-BLD-11，pending），macOS Desktop + 本机 Docker 远端，
  run `local-docker-20261020164304-74afb1` 1/1 通过：设备卡 已连接 → 连接中 → 已连接；Supervisor pid 147→349、Core pid 158→360；
  会话 `remoteSessionId` 换代后续发成功。
- 未验证：服务器队列 `r3-server-qa-restartservice`；WSL / Docker transport；Windows / Linux 桌面；英文界面 E2E；
  手机端复用 RDUX-08 未重跑；重启菜单项未截深浅主题图（普通菜单项样式）；`crash-loop-stopped` 未用真实进程（退避共 31 秒），
  以进程内真实 Supervisor + mock fork 覆盖。
- 已知限制：`restart` 不取 `run/update.lock`，与 update 的互斥只由桌面 Host 按设备保证（终端并发 restart 与 update 未覆盖）。
  2026-10-21 已按 01 的评审决定改为取锁，锁被占用时直接失败，见 R2 §8.1。
- 待确认：重启在旧进程退出前失败（如 control 无响应）且在线连接仍在时，沿用更新失败规则恢复为 online 带错误，
  现有展示模型显示为“连接失败”，与更新失败现状一致，未改。
