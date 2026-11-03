# provider-provisioning-status

数据同步页「模型提供商」分类（`docs/remote/data-sync.md`「模型提供商（只读）」、R3 §8.3.6）的本机 Host 服务：按 sourceServerId 读取 / 重试 Main 协调器的 Provisioning lane。

- `IProviderProvisioningStatusService`（通道 `provider-provisioning-status`）：`getStatus({ sourceServerId, waitForIdle? })`、`retry({ sourceServerId })`，都返回 `ProviderProvisioningLaneStatus`（`{ lane: "none" }` 或 `{ lane: "present", running, lastResult? }`）。
- `createHostProviderProvisioningStatus(postMessage)`（`node.ts`）：Host 侧实现，经 `provider-provisioning-lane-request` 请求 Main，按 requestId 接收 `provider-provisioning-lane-result`；Host 消息循环把结果交给 `handleResult`。

不变量：

- 结果的唯一数据源是 Main 协调器的 lane；本服务不缓存、不持久化。
- 只在桌面本机 Host 注册，不进入远程 workspace RPC 合同、source-settings 服务集合和手机白名单。
- 不设超时：Main 对每个请求都应答（没有协调器时回「无 lane」）。
