# evidence 目录说明（真机证据 JSON，不入库）

本目录曾存放 Windows app frame surface 修复期间（2026-10-24 / 10-25）的 17 份脱敏真机探针 / 回归证据 JSON，合计约 13.5 万行。体积过大且属于过程产物（代码、测试、脚本均不引用，仅 spec 文档提及），自 2026-10-25 起不再入 git，仅存本机 `.tmp/windows-app-frame-surface/evidence/`（与 spec §7.7 所述原始材料同址）。

迁移提交前后的文件 sha256 一致；如需找回原始文件，可从移除提交之前的 git 历史获取：`git log --oneline -- docs/cua/evidence/` 定位提交后 `git show <commit>:docs/cua/evidence/<文件名>`。

引用这些文件的 spec（`../2026-10-23-windows-app-frame-surface-spec.md`、`../2026-10-13-windows-harness-fixture-matrix.md`）中的链接已改为文件名说明。E 编号事实以 spec 正文为准；脱敏 JSON 仅是当次轨迹记录，其中的 HWND/PID/TID **禁止固化为后续测试选择器**。

## 已迁出的文件清单

| 文件 | 内容 |
| --- | --- |
| `2026-10-24-windows-surface-independent-probes.json` | 独立探针轮（P 编号） |
| `2026-10-24-windows-surface-followup-probes.json` | 补测轮（R 编号） |
| `2026-10-24-wgc-secondary-window-probes.json` | WGC 对照轮 |
| `2026-10-25-windows-frame-harness.json` | 第 2 步捕获管线真机证据 |
| `2026-10-25-windows-panel-harness.json` | 第 3 步面板真机证据 |
| `2026-10-25-windows-menu-harness.json` | 第 4 步菜单真机证据 |
| `2026-10-25-windows-operation-harness.json` | 第 5 步操作关联真机证据 |
| `2026-10-25-windows-receipt-boundary-harness.json` | 第 6 步回执边界真机证据 |
| `2026-10-25-windows-real-notepad.json` | 真实应用：记事本 |
| `2026-10-25-windows-real-explorer.json` | 真实应用：资源管理器 |
| `2026-10-25-windows-real-shotcut.json` | 真实应用：Shotcut |
| `2026-10-25-windows-real-zotero.json` | 真实应用：Zotero |
| `2026-10-25-windows-real-notion.json` | 真实应用：Notion |
| `2026-10-25-windows-real-wps.json` | 真实应用：WPS（含停止点） |
| `2026-10-25-windows-real-followup-regression.json` | 真实链路修复回归 |
| `2026-10-25-windows-real-chain-regression.json` | 真实链路修复回归（48 组） |
| `2026-10-25-windows-native-classification-regression.json` | 原生分类修复回归（49 组） |
