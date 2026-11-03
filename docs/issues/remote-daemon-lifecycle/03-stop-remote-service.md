# 03 — 停止远端服务（端到端）

Status: done

## Parent

[01 — 在设备卡上停止和重启远端服务](01-stop-restart-remote-service.md)

## What to build

用户在「设置 › 远程设备」设备卡的「更多」菜单点击「停止远端服务」，确认后远端服务真正退出，设备显示“未连接”，
本机不会在之后把它自动拉起。用户再点“连接”时，照常启动远端服务。合同见父票与
[R2 §8.1](../../architecture/r2-server-cli-and-daemon.md#81-stop---wait-与整棵进程树-restart2026-10-20)、
[R3 主规格](../../architecture/r3-source-server-remote-architecture.md) §8.4.5、
[连接 UX RDLC-01](../../architecture/remote-device-connection-ux-spec.md#停止与重启远端服务rdlc-01)。

- **远端 CLI**：`zcode stop --wait` 使用 #02 的停止等待函数，锁释放且 status 为 stopped 后才返回最终 ServerStatus。
  daemon 未运行时立即成功。Supervisor 进入 `stop-failed` 时返回 `source-server-stop-failed`，control 超时返回
  `source-server-control-unresponsive`。两个错误码加入公开错误码表，并有 UI 文案。
- **Host**：连接管理器新增按设备停止的能力。先完整执行显式断开收口（删除恢复意图），再经 transport 执行
  `stop --wait --json`。路由与更新一致：在线连接 → 默认连接 → 最近连接中可静默取得凭据的连接；取不到时返回
  `credentials-required`。成功和失败都保持 offline。同一设备的更新与停止互斥。
- **管理服务**：新增 `stopSource(sourceServerId)`，有严格 schema，只对桌面 Renderer 开放。开始、成功、失败各写一条设备操作日志。
- **设备卡**：「更多」菜单在「复制设备 ID」与「移除设备」之间加分隔线分组，放入 destructive 样式的「停止远端服务」。
  - 可用状态按父票表格计算，可用状态函数同时为 #04 的「重启远端服务」留出位置。
  - 版本门禁：最近握手的远端版本低于本合同首个版本常量或版本未知时，菜单项禁用并提示“更新远端服务后可用”。
  - 点击后弹 destructive 确认，默认聚焦取消、回车不执行。本票只放通用中断说明，任务清单与其他影响说明见 #05。
  - 确认后复用同设备互斥；成功和失败都给 toast，失败 toast 可打开失败详情。
  - 中英文文案统一称“远端服务”。

## Acceptance criteria

- [x] CLI 测试：`stop --wait` 在锁释放前不返回；daemon 未运行时立即成功；`stop-failed` 与 control 超时分别返回对应公开错误码，且不 kill 任何进程。
- [x] 连接管理器测试：远端命令执行前恢复意图已删除；在线连接关闭后不排重试、不进入离线探测；结果为 offline；离线设备按默认连接执行；凭据不可静默取得时返回 `credentials-required`；更新进行中时停止被拒绝。
- [x] 设备卡测试：已连接、未连接、连接失败时可用；连接中、更新中时禁用；需要处理时隐藏；低版本或版本未知时禁用并显示提示；取消确认不调用服务；成功与失败 toast 正确。
- [x] 桌面 E2E（R3 daemon 测试环境）：从设备卡「更多」停止后，远端 Supervisor 与 Core 进程退出，设备显示“未连接”，等过一个自动重试周期仍未被拉起；再点“连接”能恢复。
- [x] 中英文 i18n key 一致；深浅主题下菜单项与确认弹窗可辨识。
- [x] case 目录与覆盖矩阵同步新增用例。
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测通过。

## Blocked by

- [02 — 预备重构：统一“停止并等待”，泛化生命周期操作 flight](02-prefactor-stop-wait-and-lifecycle-flight.md)

## Comments

### 2026-10-21 完成记录

- Commit：`c69d406a95` feat(remote): stop remote service from device card
- 实现：CLI `stop --wait`（复用 `stopSupervisorAndWait`，新 `stop-failed` 立即失败）；control 超时统一返回
  `source-server-control-unresponsive`；公开错误码新增 `source-server-stop-failed`、`source-server-control-unresponsive`；
  Host `stopSource`（先 `disconnectSource` 再执行 `stop --wait --json`，登记 `stop` 类型 flight 参与互斥，失败原因写在所选连接的
  `offline` 状态上）；`directory.resolveSourceLifecycleRoute` 离线路由；管理服务 `stopSource`；操作日志新增 `stop`；
  设备卡「更多」分组与 destructive「停止远端服务」、可用状态函数 `resolveSourceServerLifecycleActionAvailability`、版本门禁；
  非公开互斥码 `source-server-operation-in-progress`；`settings.source.error.credentials-required` 文案；术语检查补 daemon/Supervisor/Core。
- 版本门禁常量：`SOURCE_SERVER_LIFECYCLE_CONTROL_MIN_VERSION = "3.16.2"`（`packages/shared/src/source-server/compatibility.ts`），
  取根 `package.json` 当前版本作占位；已发布的 3.16.2 远端不支持 `stop --wait`，**发版时必须改为真正首发本功能的版本**。
  2026-10-21 已改为 `3.16.3`，见 [01 完成记录](01-stop-restart-remote-service.md#2026-10-21-完成记录)；
  2026-10-27 改为 `3.17.0`，见 [01 版本门禁改为 3.17.0](01-stop-restart-remote-service.md#2026-10-27-版本门禁改为-3170)。
- 验证：`pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e` 通过；`pnpm lint` 0 error；`pnpm architecture:check --changed` 0 violation；
  `pnpm test:unit:affected --base 272d9f8f87` 通过（1487 文件 / 16731 例，6 例跳过）；server-cli、Host、UI 定向测试通过；
  `e2e:fixture:check`、`pnpm audit:conversation-session-coverage` 通过；改动文件 `oxfmt --check` 通过；`check-competitor-terms` 0 处。
- E2E：`conversation-session-r3-stop-remote-service`（R3A-BLD-10，pending），macOS Desktop + 本机 Docker 远端（OrbStack linux/arm64，
  远端 3.16.2），run `local-docker-20261020155045-31aaa6` 通过：远端进程 2→0，等过一个自动重试周期仍为 0，再点“连接”后
  Supervisor pid 135→506、Core pid 146→517；深浅主题菜单与确认弹窗截图已人工查看。第 1 次失败为用例时序（已修为先等成功 toast）；
  第 2、3 次失败在首连选目录前置阶段（“远程 workspace route 尚无可用 renderer attachment”），与同机并发单测重叠，疑为负载下的存量首连时序问题，**根因未确认**。
- 未验证：服务器队列 `r3-server-qa-stopservice`；WSL / Docker transport；Windows / Linux 桌面；E2E 英文界面（中英文 key 一致由单测覆盖）。
- 行为影响：control 超时码对所有 control 命令生效，更新 apply 超时提示从“连接超时”变为“远端服务无响应”；
  `stopSupervisorAndWait` 的两条新规则（新 `stop-failed` 立即失败；status 已 stopped 而 control 关闭时只等锁释放）同样作用于
  update handoff 与 `serve --daemon`；失败 toast 的“查看详情”优先打开 `failed` 连接，否则打开最近带错误的连接（更新失败回跳同样适用）。
- 存量文案 `remote.sourceServerInstallDescription` 含“后台 daemon”，术语测试对该 key 显式豁免，待确认是否改写。
