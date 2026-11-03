# 远程设备设置页字号小于其他设置页

Status: ready-for-human

所属：[01 分诊记录](01-ticket-triage.md)。工单：ZCT-2112858863014739968。行号以 `v3.16.2` 为准。

## 现象

Windows 用户反馈“远程设备里面的字怎么这么小”。截图中页标题约 30px（等于默认 `--ui-font-size: 14px` 下的 `text-ui-settings-title-lg`），说明用户使用默认字号与 100% 缩放；正文与说明明显小于其他设置页。

## 已确认（代码）

| 元素     | 远程设备页（`packages/ui/src/settings/SourceServerManagementPanel.tsx`） | 共享 `SettingsRow`（`settings/SettingsPageParts.tsx`） |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| 页面说明 | `:715` `text-ui-sm`（12px）                                              | —                                                      |
| 分组标题 | `:1632` `text-ui-base`（14px）                                           | —                                                      |
| 行标题   | `:1640` `text-ui-sm`（12px）                                             | `:133` `text-ui-base font-medium`（14px）              |
| 行说明   | `:1645` `text-ui-xs`（10px）                                             | `:135` `text-ui-base`（14px）                          |
| 空状态   | `:1675` `text-ui-sm`（12px）                                             | —                                                      |

- 该文件 `text-ui-xs` 16 处、`text-ui-sm` 16 处、`text-ui-base` 5 处；设置目录下其他面板以 `text-ui-base` 为主。
- DESIGN.md：`text-ui-base` 用于正文、主 UI 文本和 section 标题；`text-ui-sm` 用于辅助说明；`text-ui-xs` 只用于快捷键、徽标、计数和很弱的元数据。行说明用 `text-ui-xs` 偏离角色语义。
- 来源：`749d0325b9`（2026-08-23，按原型审计对齐 R3 远程界面）引入紧凑字号，之后只改过颜色。不是 3.16.2 回归。

## 需要确认

远程设备页的紧凑排版是否是有意保留的设计。若不是，按 DESIGN.md 角色对齐：行标题、页面说明、空状态改 `text-ui-base`；行说明改 `text-ui-sm` 或与 `SettingsRow` 一致；`text-ui-xs` 只留给徽标/计数类元素。只改 class，不改结构。

## 3.16.3 状态

`v3.16.2..HEAD` 没有改该文件。未修复。

## 验证要求

纯视觉调整：桌面与窄屏、深浅主题、14/16px 界面字号视觉验证；同步远程设备卡相关 E2E 的断言（若有）。
