# local-ttft-contract

协议和本地异步日志队列的公共合同。无文件或网络 I/O；写入由 adapter 注入。关联、容量与时钟误差均有界，localOnly 决定在发送开始时冻结。

完整时序、字段和验证口径见 `docs/monitoring/ttft-stage-telemetry.md`。
