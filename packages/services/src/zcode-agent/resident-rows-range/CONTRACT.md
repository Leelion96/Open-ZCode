# remote-resident-rows-range

手机浏览项目任务列表时，用 `rowsRange` 的 `residency: "resident-only"` 预加载会话最新一页。本模块是 Host 侧的执行端能力确认：`runtime/capabilities` 声明 `residentRowsRange: true` 才转发。

不变量：

- 只读：只读已在内存的会话，不拉起工作区 CLI，不冷恢复，不重建投影。
- 旧 CLI 不认识 `residency`，会剥掉参数并冷恢复；能力未声明或查询失败时一律按不支持处理，Host 回 `proto.sessionNotResident`。
- 能力结果按 client 缓存；查询失败不缓存，下次重新确认。
