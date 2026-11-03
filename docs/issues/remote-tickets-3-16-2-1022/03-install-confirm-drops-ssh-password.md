# 安装确认交接丢失 SSH 密码，报“SSH 认证失败”

Status: done

所属：[01 分诊记录](01-ticket-triage.md) §认证失败。已确认样本：ZCT-2113085028132474880（带日志）。首要候选：ZCT-2113021923315200000。行号以 `v3.16.2` 为准。

## 现象

3.15 升级用户，SSH 用密码登录，远端还没装 Source Server。从侧栏项目（或项目 tab 重连）进入连接，Host 报“需要安装”，用户在向导点“安装并继续”，约 0.4s 后报“SSH 认证失败：请检查用户名、密码或私钥配置”。

## 已确认的机制

```text
侧栏项目「连接」→ requestRetainedRemoteProjectConnection（ui/src/project-sidebar/remote-project-connection.ts:43-122）
  sourceId = getWorkspaceSourceServerId(...)  → 迁移的 Profile 与历史都没有 sourceServerId → null（:82）
  profile = undefined（:91-92 只按 sourceServerId 找 Profile）
 └─ Host remote-projects.connectHost（desktop/src/host/index.ts:3774-3811）按自己的规则找到 Profile
     → 用已存密码认证成功 → probe 未安装 → SourceServerInstallRequiredError
 └─ UI openWizard({ preferredTarget: host.target（无 secret），无 preferredProfileId，initialFailure: install-required })（:99-101）
 └─ 向导 applyPreferredTarget（remote-connection-flow/index.ts:1498-1529，:1502 清空密码）→ setPendingInstallConfirmation
 └─ 「安装并继续」handleConfirmInstall（:1090-1101）：没有凭据门禁（对比 handleStartPendingRemoteConnection :1157-1166 有）
 └─ 连接 target 无密码、无私钥；Windows 无 SSH_AUTH_SOCK → ssh2 只试 ["none"]
     → All configured authentication methods failed → sshAuth.ts:72-80 “SSH 认证失败”
```

- 样本日志（+08:00）：09:47:57、09:48:02 `connectHost FAIL SourceServerInstallRequiredError`（Host 用已存密码两次认证成功）；09:48:10.763 `用户确认安装`；当时 Profile 只有 `passwordCredentialKey`、无 `sourceServerId`、`sourceServers: []`；09:48:11.205 `remote-authentication-failed`，`confirmSourceServerInstall: true`。同一主机同一密码：Host 侧成功，Renderer 安装确认那一次 0.43s 被拒。
- 探针：`git archive v3.16.2` 的真实 UI 模块。Profile 无 sourceServerId 时，确认安装后 `onConnect` 收到的 SSH target 无 password；有 sourceServerId 的对照组带已存密码。修复线 HEAD 结果相同。
- 违反规格：[项目导航](../../remote/project-first-remote-navigation-spec.md) “需要交互时携带精确 Profile”。

## 性质

实现 bug。背后有设计债：Profile/凭据由 Renderer 与 Host 两处各自解析，映射规则不一致。

## 需要确认

凭据解析的归属。可选方向：

1. 最小修法：交接时用 `SourceServerInstallRequiredError` 已带的 `profileId` 补 `preferredProfileId`，让向导走读取凭据的分支；或让 UI 找 Profile 的规则与 Host 的 `remoteProjectHostIdForProfile` 一致。
2. `handleConfirmInstall` 与 `handleStartPendingRemoteConnection` 使用同一凭据门禁：SSH 无密码且无私钥时转“补凭据”。
3. 根本方向：安装确认后的连接由 Host 按 profileId 解析凭据，Renderer 不再自行拼 secret（单一数据源）。

## 3.16.3 状态

分诊时（2026-10-22）修复线未修复：认证相关的 `57b1af9e1d`、`54bfa36560`、`4d2039642d`、`1e58d74c03`、`70cb10602b` 都不覆盖。之后已在本分支修复，见下文实施记录。

## 验证要求

- UI 单测：迁移的密码 Profile 无 sourceServerId，从项目入口进入安装确认，断言连接 target 带凭据或进入补凭据。
- 桌面 E2E：3.15 迁移的密码 Profile、远端未装 Source Server、从侧栏项目进入并安装。

## 实施记录（2026-10-22）

采用最小修法（方向 1）。方向 3“由 Host 按 profileId 解析凭据”改动更大，未做，仍是设计债。

- 首次出错点实测：侧栏入口经 `remote-projects.connectHost` RPC 拿到 Host 的等待点错误，但 RPC 错误白名单不含 `profileId`（`packages/rpc/src/channelServer.ts`、`channelClient.ts`），交接处读不到实际操作线路。
- 修复：
  - RPC 错误透传 `profileId`（server/client 白名单与 `channels.shared.ts` 类型）。
  - `requestRemoteProjectConnection` 的 catch 分支：Host 等待点带 `profileId` 且目标是 SSH 时，交接 `preferredProfileId`，向导走已有的 `handleSelectProfile`，先加载该 Profile 的凭据再进入安装确认。WSL/Docker 目标不含凭据，沿用原交接。
- 未加 `handleConfirmInstall` 凭据门禁：修复后入口都能交出精确 Profile，门禁属于兜底，未加入。
- 验证：
  - 单测：`packages/rpc/test/channels.test.ts`（profileId 透传）、`packages/ui/test/remoteProjectConnectHandoff.test.ts`（迁移形状的侧栏项目交接 `preferredProfileId`）、`packages/ui/test/useRemoteWorkspaceHistoryDirectoryProjection.test.ts`（tab 路径交接），修复前均失败。
  - E2E `conversation-session-ssh-remote-legacy-install-handoff`（pending，本机 Docker SSH）：用 App 自己加密的密文预置 3.15 旧密码，冷启动完成迁移；侧栏（LIH-01）与恢复的旧 tab（LIH-02）确认安装后均带已存密码上线。只还原本修复时两例都报“SSH 认证失败”。运行时日志确认侧栏 catch 收到 `code=source-server-install-required` 与 `profileId`。证据 run 见覆盖矩阵 R3A-LEGACY-INSTALL-HANDOFF。
