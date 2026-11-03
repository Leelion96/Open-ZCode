# 连接向导「一键同步」入口在现有流程中不可达

Status: needs-triage

数据同步票 [14](../data-sync/14-route-legacy-sync-entries.md) 把连接向导「一键同步」下拉改为打开数据同步弹窗。实现时发现：项目入口、设置入口和输入框入口在连接完成后都进入设备管理或项目编辑器，不进入目录步骤，所以正常流程到达不了这个按钮。该入口目前只有单测 `remoteConnectionDialogContentLayout.test.ts` 覆盖，没有 E2E。

待决：

- 删除该入口；或
- 让某个连接流程重新进入目录步骤，并补 E2E。

本期（数据同步 MR）保留该入口，行为与其他 5 处入口一致。
