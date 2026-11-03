# desktop-web-remote-relay

将 Main 的 HTTP、存储和 device WebSocket 与 manager 装配隔离。

仅 index.ts/contract.ts 供外部消费。manager 仍唯一拥有 window runtime 与 attachment；transport 唯一拥有 socket/generation。storage 只保存非敏感身份，clearLegacy 合并并发且失败可重试。凭据从注入端口读取，HTTP 错误只返回分类。

完整语义见 [Relay V2 spec](../../../../../docs/web-remote-control/relay-v2-pairing.md)。

## 通知上报 owner

MobilePushConnection 按账号和环境管理 HTTP 通知资格、执行归属和单次上报，不为通知建立 WebSocket。远控 transport 由各窗口 runtime 独立持有，与通知无关。通知和远控共用持久设备注册 owner。切号或切环境中止旧请求并清除执行归属，同账号重复登录通知不清除；事件尝试后内存去重，不重试、不补发。GET status 协商 HTTP 能力，POST events 返回处理回执，回执不代表手机送达。
