# cli-session-data

`v4/storage/sessionData/measure` / `purge` 的 CLI 执行面。通过 `SessionDataHost` 窄接口使用 session store、会话文件端口与本进程的会话驻留事实。规格见 `docs/superpowers/specs/2026-10-24-project-management.md`「彻底删除数据」，存储细节见 `apps/zcode-cli/docs/design/v2/session-persistence.md`「彻底删除」。

不变量：

- 以会话根为单位：根与其自有后代（不含 fork）组成一棵树，整棵删或整棵留。
- 树中任一会话在本进程忙（在途 turn、待处理交互或排队命令）时整棵保留，返回 `kept`（`running`）；树中任一会话的附件仍被本次不删除的未删除会话引用（part 中的 `zcode-artifact://<sid>/…`）时整棵保留（`referenced`），按不动点传递。空闲已加载的会话只做驻留去激活（与 resident 容量去激活同一路径），**不**发 `session.removed`。
- 先删文件再删行：文件删除失败时保留行并返回 `failed`，重试仍能按会话找到文件。文件与行都删除后才从本进程所有 sessions-index 投影中移除，防止下次快照复活；失败时列表与 Host 镜像不变。
- Host 负责把会话交给持有其运行态的进程（该 cwd 已有 Agent 进程时）；其余进程只能看到自己加载的会话。
