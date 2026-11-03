# 扫码远控执行遥测契约

一个执行服务 workspace 持有一份归集器，寿命不绑定手机 attachment 或桌面 pane。
输入为 CLI live facts，只有可信 command 来源为 mobile 的执行及其子任务被接管；
返回的接管标记用于阻止 renderer 再次计数。PC 续聊按新 command 单独判定。

复用 shared 归集算法，通过注入的 reporter 仅输出 completion/step；输出清洗后经 Host-only
事件交给 Main 现有 TelemetryCore。snapshot/replay 不补报，dispose 清理统计状态，
不改变业务命令、任务和队列。远端 Source 的订阅必须先检查能力声明。

协议与验收见 [对话埋点规范](../../../../docs/monitoring/conversation-telemetry-v4.md)。
