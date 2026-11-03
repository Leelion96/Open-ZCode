# local-ttft-renderer

Renderer 是一次发送观测的唯一 owner。首输出必须来自 online 实际内容；检查点、ACK 和历史快照不能抢占。DOM 与绘制估计只匹配同一会话、轮次和正文行；日志失败不影响投影。

完整时序、字段和验证口径见 `docs/monitoring/ttft-stage-telemetry.md`。
