# cli-session-data-files

CLI 存储根下按会话与目录定位、测量、删除数据文件的 adapter，供 `v4/storage/sessionData/*` 使用。规格见 `docs/superpowers/specs/2026-10-24-project-management.md`「彻底删除数据」。

不变量：

- 会话文件位置：`cli/{artifacts,exec,agents,sessions}/<sid>` 与 `cli/{debug,rollout}/model-io-<sid>.jsonl`。会话 ID 只接受 `[A-Za-z0-9_-]`，其余拒绝（`session-data.invalid-session-id`），不能借 ID 逃出存储根。
- 记忆目录由调用方注入的 `memoryRoot`（与 CLI 记忆解析同一函数）定位，删除其父目录；父目录必须是 `memories/projects` 的直接子目录，否则拒绝（`session-data.memory-outside-storage`）。
- 测量用 lstat，只计普通文件，不跟随符号链接；路径不存在按 0。remove 先测量再删除，返回删除前大小，因此重复删除幂等。
