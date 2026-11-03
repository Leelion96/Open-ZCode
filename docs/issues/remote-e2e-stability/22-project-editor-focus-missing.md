# 从项目菜单打开编辑器后焦点仍在页面 body

Status: ready-for-human

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，测试补丁 08。
批次 `r3-server-20261011143037600-31012b` 的 `uipairwise` 在 132.2 秒失败。

## 运行证据

英文、深色、960×700 场景中，通过真实项目菜单点击 Edit project，编辑器和正确目录都已显示。
测试等待 5 秒，要求 activeElement 位于可见编辑器内；最终 `focusFailure={tag: "BODY", testId: null}`。
录像末帧显示编辑器输入框没有焦点环。这次没有手动 focus 输入框，也没有立即读取挂载首帧就失败。

```text
项目菜单 → Edit project → 编辑器显示
  → 等待可见焦点进入编辑器（5 秒）
  → activeElement 仍为 BODY
```

`ProjectEditor` 名称输入框声明 autoFocus，项目菜单通过 `onSelect` 打开编辑器。
需核对菜单退出时的焦点归还与 Dialog 焦点管理之间的顺序；当前证据尚未唯一定位到某个回调。
本轮不修改业务实现，不在测试中强制 focus 掩盖问题。后续中文/浅色、离线与重连矩阵未到达。

本项对应 [R3A-UI-03](../../testing/r3-remote-automation-case-matrix.md) 的焦点可用要求。
证据位于上述批次 `uipairwise` 的 `ui-pairwise.json`、失败录像和日志。

## 2026-10-20 最新 staging 复验

基线 `52cd1bc1d3`，批次 `r3-server-pending-52cd-b-pending-uipairwise` 再次复现。
首先修正旧 E2E 的原生设备 `title` 断言，按 RDUX-12 检查可见设备名和真实悬停详情；
完整设备名、远端路径与无操作按钮均通过，项目菜单也正常显示。
随后点击 Edit project，仍在 5 秒焦点断言失败，`ui-pairwise.json`
记录 `focusFailure={tag:"BODY",testId:null}`。没有强制 focus 或增加延时，
中文浅色及离线重连步骤仍未到达。
