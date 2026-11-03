# 02 — 预备重构：统一“停止并等待”，泛化生命周期操作 flight

Status: done

## Parent

[01 — 在设备卡上停止和重启远端服务](01-stop-restart-remote-service.md)

## What to build

行为不变的预备重构，为后续停止和重启铺路。

- 远端 Server CLI 中有两份几乎相同的“停止现有 Supervisor 并等待”逻辑：update handoff 的停止步骤，以及 `serve --daemon`
  在 fallback→service 迁移和 `stop-failed` 收口时的停止步骤。两者合成一个函数：读取停止前基线，向 control 发送 stop，
  等到 data-root 锁释放且 status 为比基线新的 `stopped`。锁缺失或 stale 时视为已停止。现有调用方全部改用它。
- Host 连接管理器的 update in-flight 集合只服务升级。把它泛化为带类型的“生命周期操作 flight”，当前只有 `update` 一种类型。
  在线连接关闭时的“预期断线”判断、显式断开和移除连接时的中止、dispose 时的清理，都改为按生命周期操作 flight 判断。
- 不新增命令、状态、错误码或 UI。

## Acceptance criteria

- [x] CLI 中只保留一份“停止 Supervisor 并等待停止完成”的实现，update handoff 和 `serve --daemon` 都调用它。
- [x] 连接管理器只用生命周期操作 flight 判断“预期断线”，不再单独维护 update 集合。
- [x] 升级期间在线连接关闭仍只做连接失效、不排重试；显式断开和移除连接仍能中止进行中的升级。
- [x] Server CLI 包与连接管理器的现有测试不改断言、全部通过。
- [x] `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。

## Blocked by

None (can start immediately)

## Comments

### 2026-10-20 完成记录

- Commit：`029e231c1f` refactor(remote): unify supervisor stop wait and lifecycle flights
- 实现：`shutdownWait.ts` 新增 `stopSupervisorAndWait`，update handoff 与 `serve --daemon`（fallback 迁移、`stop-failed` 收口）统一调用；
  连接管理器 `updateFlights` 泛化为 `lifecycleOperationFlights`（`kind` 当前只有 `update`，保留同 Source 多 flight 的 Set 语义）。
  新增 `packages/zcode-server-cli/test/shutdownWait.test.ts`（4 例，先红后绿）；现有测试断言未改。
- 验证：`pnpm typecheck` 通过；`pnpm lint` 通过（0 error，告警均为存量）；`pnpm architecture:check --changed` 0 violation；
  `pnpm test:unit:affected` 通过（10 文件 / 176 例）；server-cli 全部测试与连接管理器、更新取消定向测试通过（35 文件 / 315 例）；
  `check-competitor-terms` 0 处。
- `pnpm fmt:check`：全仓失败，集成基线 `9547d7c901` 上同样有 1985 个存量文件不合格；本次改动文件单独 `oxfmt --check` 通过。
- 行为细节：`serve --daemon` 的停止步骤新增锁预检，Supervisor 在读 status 与发 stop 之间退出时从报错改为视为已停止；
  锁不可读时在发 stop 前失败；停止前校验失败文案统一为 `Cannot verify Server status/lock before <operation>`。
- 未验证：未跑 E2E（本票不改交互与 UI）。
- 留给 #04：在线连接关闭时仍调用 `invalidateOnlineConnectionForUpdate`（投影 `updating`、失效原因 `update`），
  removeProfile 后接回恢复仍只检查 `updating`；加入 `restart` 类型时按 flight 类型区分。
