# 05 — 确认弹窗：运行中任务清单与影响说明

Status: done

## Parent

[01 — 在设备卡上停止和重启远端服务](01-stop-restart-remote-service.md)

## What to build

用户点击「停止远端服务」或「重启远端服务」后，确认弹窗先列出将被中断的运行中任务，再完整说明操作的影响，
让用户判断现在能不能停。规则见
[连接 UX RDLC-01](../../architecture/remote-device-connection-ux-spec.md#停止与重启远端服务rdlc-01)。

- **Host**：连接管理器新增按设备读取运行中任务的能力，经 transport 执行 `running-tasks --json`，路由与凭据规则同 #03。
  输出为 `null`、命令失败或 schema 不符时，返回“清单不可用”，不当作没有任务。
- **管理服务**：新增 `getSourceRunningTasks(sourceServerId)`，有严格 schema，只对桌面开放。
- **设备卡**：点击菜单项后先读取任务，再打开 destructive 确认。读取期间菜单项进入同设备互斥，避免重复点击。弹窗说明依次为：
  1. 会中断此设备上所有运行中任务，任务不会自动续跑；
  2. 任务清单：复用强制更新的清单展示；不可用时显示“设备未提供任务清单”；
  3. 其他电脑上的 ZCode 若连着这台设备，可能重新启动远端服务；
  4. 仅停止、且「启动时自动重连」开启时：下次打开 ZCode 会重新启动远端服务。
- 凭据不可静默取得时，在读取阶段就给出与更新相同的补充凭据提示，不打开确认弹窗。
- 中英文文案同步补齐。

## Acceptance criteria

- [x] 连接管理器测试：返回清单；`null`、非零退出、schema 不符都返回“清单不可用”；离线设备按默认连接读取；凭据不可静默取得时返回 `credentials-required`。
- [x] 设备卡测试：停止和重启的弹窗在“有任务”“无任务”“清单不可用”三种情况下文案正确；“启动时自动重连”的提示只在停止且开关开启时出现；读取失败为 `credentials-required` 时不打开弹窗并显示补充凭据提示；读取期间不能重复触发。
- [x] 中英文 i18n key 一致；深浅主题与窄窗口下任务清单可读、可滚动。
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测通过。

## Blocked by

- [03 — 停止远端服务（端到端）](03-stop-remote-service.md)
- [04 — 重启远端服务（端到端）](04-restart-remote-service.md)

## Comments

### 2026-10-21 完成记录

- Commit：`ce7e66f994` feat(remote): list running tasks before stop or restart
- 实现：Host 只读 `getSourceRunningTasks`（路由同 `restartSource`；`null`、非零退出、执行异常、schema 不符都返回“清单不可用”；
  不改连接状态、不写操作日志；更新流程的清单读取改用同一函数）；shared `sourceServerRunningTasksResultSchema`（清单 / 不可用二选一）；
  管理服务 `getSourceRunningTasks`（只对桌面开放）；设备卡先读任务再确认，读取、确认、执行处于同一 `source:<id>` 互斥；
  说明顺序为中断说明 → 任务清单（共用 `formatSourceServerRunningTasks`，空清单与不可用各一新 key）→ 其他电脑可能重启远端服务 →
  仅停止且启动自动重连开启时的提示；`credentials-required` 不开弹窗，显示补充凭据提示；ConfirmDialog 新增可选
  `scrollableDescription`（限高滚动，未设置的调用方不受影响）。
- 验证：`pnpm typecheck`、`typecheck:e2e` 通过；`pnpm lint` 0 error；`pnpm architecture:check --changed` 0 violation；
  定向测试 12 文件 / 202 例通过（Host 新增 10 例，设备卡新增 11 例）；`pnpm test:unit:affected --base 9442e3fff9` 1490 文件通过、
  1 例失败：`packages/services/test/subagentRuntimeConfigWatcher.test.ts` 的文件监听用例，本次未改动该区域，单独重跑 27 例全过，
  判断为负载下的存量不稳定；改动文件 `oxfmt --check` 通过；`check-competitor-terms` 0 处。
- E2E（macOS Desktop + 本机 Docker 远端，未与单测并发）：停止 R3A-BLD-10 run `local-docker-20261020172600-b21ce3` 通过
  （新增断言：四段说明；远端输出 `[]` 时显示“此设备当前没有运行中的任务”；480×640 窄窗口长清单可滚动、长路径不横向溢出、按钮在视口内；
  深浅主题 × 宽窄窗口截图已人工查看）；重启 R3A-BLD-11 run `local-docker-20261020173010-b7488c` 通过；两例 `e2e:fixture:check` 通过；
  `pnpm audit:conversation-session-coverage` 通过。
- 未验证：服务器队列；WSL / Docker transport；Windows / Linux 桌面；英文界面 E2E；E2E 中远端有真实运行中任务时的清单行（仅单测覆盖）。
- 已知现象：远端服务刚就绪的约 10 秒内 `running-tasks --json` 输出 `null`（Supervisor 只从 Core 心跳得知清单，就绪时不立即上报），
  弹窗显示“设备未提供任务清单”，符合 spec；远端不可达时读取阶段要等 transport 超时，期间菜单禁用（`exec` 执行中不响应中止）。
