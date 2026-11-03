# WSL 过期失败交接为 “Connection failed”，迁移 Profile 与新 Profile 分裂

Status: ready-for-human

所属：[01 分诊记录](01-ticket-triage.md)。工单：ZCT-2112984371086536704。行号以 `v3.16.2` 为准。

## 现象

Windows WSL 用户反馈“连接失败”，附带的连接日志只有两条 INFO：`Source Server installation requires explicit user confirmation`。实际上设备在 00:11（本地 UTC+3）已安装并在线，之后 6 次连接都成功。22:08 用户再点旧项目，向导显示 “Connection failed”，没有安装按钮，也没有发起连接；反馈带出的是 22 小时前那次尝试的 4 行日志。

## 已确认：呈现层 bug

```text
00:05 旧项目重连（先连后交接）→ install-required（code 正确）
  └─ 旧 tab 只存本地化文案：lastConnectionError = "The remote device is not installed…"（无 code）
     （useRemoteWorkspaceHistory.ts:1439 → reconnectRemoteWorkspaceHistoryEntry.ts:339-340 → lib/remoteWorkspaceHistory.ts:439-444）
     只有同一个 key 再次连接成功才会清 → 旧 key 永远连不上 → 一直不清
22:08 再点旧项目（先判后交接）
  └─ getWorkspaceSourceServerId：旧 history 无 sourceServerId → 设备 undefined（sourceIdentity.ts:11-39）
  └─ presentation({projectError: 旧文案}) → failed/retry（remoteConnectionPresentation.ts:174-186）
  └─ requestRemoteProjectConnection：failed → 不重连，直接 openWizard；code = undefined（:36-56）
  └─ acceptInitialFailure：reasonCode 为空 → remote.error.unknown = "Connection failed"；不设安装面板
     （remoteConnectionPresentationErrors.ts:80；remote-connection-flow/index.ts:1301-1309）
```

- 日志：22:08 只有 getSnapshot/readDirectory/readTree，没有 `connecting window-scoped remote source`（最后一次在 22:01）；旧 tab 的失败记录在全天 13 次设置写入中一直不变。
- 探针（真实 v3.16.2 代码）：22:08 场景得到 failed/retry、不重连、code undefined、“Connection failed”、无安装面板，与工单一致。反事实“设备在线”同样得到 “Connection failed”：过期 projectError 压过在线状态。
- 违反规格：[项目导航](../../remote/project-first-remote-navigation-spec.md) “交接只使用操作线路的状态和错误”。侧栏行读 Host 投影显示 “Installation required”，与点开后的向导不一致。

## 高概率：设计缺口（Profile 分裂）

```text
旧工作区 {wsl, Ubuntu} --迁移 v1--> Profile A（无 user）← 旧项目/旧 history 绑在这里，停在 needs-install
渲染层重连：Main 解析默认用户 → {Ubuntu, <user>}
  → ensureProfile 按完整 target 精确匹配失败 → 新建 Profile B（sourceServerDirectory.ts:226-305）
  → 安装与上线都记在 Profile B / 新 Source 上；旧项目永远绑不到新设备
```

规格禁止“把省略用户当作任意用户匹配”，但没有规定迁移来的无 user Profile 在首次解析出默认用户后如何与新 Profile 归一。

## 次要 UX bug

交接后的向导同时显示安装面板（“Install and continue”）与错误面板；错误面板主按钮文案是 “Install and connect”，onClick 落到不带确认的 `onRetry()`（`RemoteConnectionConnectingStep.tsx:556-569` → `remote-connection-flow/index.ts:1151-1175`）。00:05:21 那次无效尝试符合这一点（高概率）。

## 需要决定 / 可直接修

- D1（需产品决定）：无 user 的迁移 WSL Profile，首次解析出默认用户并探测到同一 home 时：回填 user、合并到新 Profile，或提示重新添加。需确认回填是否违反“省略用户不能匹配任意用户”。
- B1（可直接修）：原地重连交接不能用无码的本地化旧错误生成失败。设备解析不到时回退到 Host 投影的状态/错误码（侧栏行已在用）；或失败记录同时保存 reason code；设备已安装或在线后清掉同一设备的旧失败记录。
- B2：安装面板出现时隐藏错误面板主按钮，或让其 install 动作调用 `handleConfirmInstall`。
- B3（低优先）：启动重连把 needs-install 计为 waiting，不计 failed/warn。

## 3.16.3 状态

未修复。相关文件在修复线都没改；`f208b09e8b`（WSL 登录输出污染身份）、`534f0e8353`、`c45427ac8d` 不覆盖。

## 待补

重启后旧项目的侧栏状态与点击结果；侧栏行、向导、设置页设备卡截图；WSL 内 `ls -l ~/.zcode/server/bin/zcode; cat ~/.zcode/server/current.json`。

## 验证要求

- UI 单测：旧 tab 无 sourceServerId + 旧 install 错误时的交接。
- 桌面 E2E：迁移 WSL 历史 → 首次安装 → 再点旧项目（可先用无 user Profile 夹具模拟同一形状）。

## 实施记录（2026-10-22，B1、B2）

B1、B2 已修复；D1（Profile 分裂）与 B3 仍待决定，所以本票保持 ready-for-human。

- B1 修法调整：原计划“等待点不写失败记录”会改变一条已有契约（`useRemoteWorkspaceHistory.test.ts` 要求自动恢复遇到需要安装/升级时静默并写失败记录），改为读取侧修复。
  - `useRemoteWorkspaceHistory.ts` 的 tab 交接：操作线路（设备）解析不到时，不再把 tab 上无码的旧失败文案当作操作线路失败；先重连，由 Host 给出当前带码的结果（等待点经 catch 交给向导）。线路已识别时项目级失败仍按原逻辑交给向导查看。
  - 3.16.2 已写下的旧失败记录不需要迁移，也不再挡住重连。
- B2：`RemoteConnectionConnectingStep.tsx` 错误面板主按钮在存在安装确认时执行 `installConfirmation.onConfirm()`，不再落到无确认的 `onRetry()`。
- 验证：
  - 单测：`useRemoteWorkspaceHistoryDirectoryProjection.test.ts`「设备尚未识别的旧项目 tab 重连时…」（修复前不重连、直接判失败）；`remoteConnectionInstallProgress.test.ts`「等待安装确认时，错误面板的‘安装并连接’执行安装确认」（修复前调用 onRetry）。
  - E2E LIH-02（SSH 形状复现 WSL 工单：恢复的旧 tab，取消安装后 `lastActiveWorkspace` 留下“远程设备尚未安装 ZCode Server，需要先确认安装。”的无码失败记录）：修复后第二次连接仍显示安装确认，点错误面板“安装并连接”完成安装；只还原 B1 时第二次连接只显示“连接失败 / 暂时无法连接”。B2 的修复前对照只在单测中完成。
- 新观察（未处理，待查）：迁移的旧项目首次安装上线后，向导打开原项目时报 `project.not-found`（E2E 新容器没有该旧 workspace 的会话，属夹具差异；与 WSL 工单 03:06“会话释放、未绑定原目录”形状相同），需在带真实 3.15 远端数据的环境确认。

## 实施记录（2026-10-22，B1 修订）

- 回归：上一版 B1 在线路未识别时忽略全部失败记录，违反 [项目导航](../../remote/project-first-remote-navigation-spec.md) §2.2“普通重连失败……再次点击进入向导连接步骤并展开失败日志，不自动再次拨号”。迁移的旧 tab 普通失败（认证失败、主机不可达、超时）后，每次点击都静默重拨，向导打不开。真实 hook 探针：修订前拨号 1→2→3 次、向导 0 次；上一版之前（基准）拨号 1 次、第二次点击打开向导。
- 根因：失败记录写入时（`reconnectRemoteWorkspaceHistoryEntry.ts`）手里有错误码，却只存了本地化文案，读取侧分不清等待点与普通失败。
- 修订：失败记录新增 `lastConnectionErrorCode`，与 `lastConnectionError` 同写同清（`protocol.ts`、settings schema、`buildRemoteWorkspaceSessionMutation`）。tab 交接在线路未识别时：带普通失败码的记录照常交给向导，不拨号；等待点码或无码旧记录先重连。规则写入规格 §2.2。
- 兼容：字段可选。旧版本读取时 schema 丢弃未知字段，只是退回“无码旧记录”的处理。
- 验证：单测 `useRemoteWorkspaceHistoryDirectoryProjection.test.ts`「按失败记录的错误码区分普通失败与等待点」（普通失败：第二次点击打开向导、只拨号 1 次；等待安装：第二次点击重连并交出 `preferredProfileId`）、`remoteWorkspaceHistory.test.ts`（码与文案同写同清）、`validation.test.ts`（schema 保留该字段），修订前均失败。E2E 新增 LIH-03（恢复的旧 tab、远端 PAM 拒绝认证）：修订后 LIH-01～03 共 3/3 通过（`local-docker-lih03-20261022150207-cbcfea`），第一次点击远端认证 1 次、不弹向导，第二次点击打开向导显示“SSH 认证失败”与连接日志，认证次数仍为 1；只还原读取规则时 LIH-03 失败，向导不出现（`local-docker-lih03-pre-20261022150618-373026`）。LIH-02 取消安装后留下的记录现在带等待点码，第二次连接仍走重连，同一次运行中通过。
