# 生产 renderer 无条件暴露模型轨迹测试 Store

Status: needs-triage

2026-10-20，staging `52cd1bc1d3` 的 SPR01 生产 CDP 回放确认。按用户要求不改业务实现。

- 生产 renderer 使用 `NODE_ENV=production`、`VITE_ZCODE_E2E_STORE_BRIDGE=0`、coverage=0 构建；产品环境为 test，和 E2E bridge 开关分离。
- 运行时只读 CDP 查询仍返回 `__zcodeModelTrajectoryStoreE2E`。SPR01 的零 Store bridge 前置断言失败，尚未执行 136 次切换或堆检查，不能声称内存释放失败。
- 根因：[modelTrajectoryStore.ts](../../../packages/ui/src/store/modelTrajectoryStore.ts) 仅检查 window 是否存在，直接注册可变全局 Store；没有使用现有 `shouldExposeE2EStoreBridge()` 门禁。其他 Session/Tab Store 已按门禁注册。
- 证据：`packages/desktop/.e2e-artifacts/pending-resume-20261019-52cd1bc1d3/retention-production-bridge-proof.json` 和 `retention-formal-52cd/test.log`。最早一次独立 App 因测试 stage 缺少根依赖 yauzl 未启动，已补完整依赖解析；它不是此业务问题的证据。
- 测试另修正了前置断言失败时的 CDP 连接清理；仍保留零 bridge 断言，不删除全局变量、不缩小匹配范围绕过问题。

验收：显式关闭 bridge 的生产构建不暴露模型轨迹测试 Store；开启 E2E bridge 的测试构建仍可用。随后重新执行 SPR01 的完整堆检查，再判断是否可转正。
