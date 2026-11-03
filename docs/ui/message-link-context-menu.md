# 消息正文链接右键菜单

消息流中的 HTTP/HTTPS 链接右键菜单按以下顺序显示：

| 分组 | 中文            | 英文            | 图标与行为                                  |
| ---- | --------------- | --------------- | ------------------------------------------- |
| 打开 | 在 ZCode 中打开 | Open in ZCode   | `PanelRight`；调用现有强制内置浏览器入口    |
| 打开 | 在浏览器中打开  | Open in browser | `ExternalLink`；调用现有强制外部浏览器入口  |
| 复制 | 复制链接        | Copy link       | `Copy`；将原始完整 URL 写入当前客户端剪贴板 |

两个打开选项相邻，只在“复制链接”之前显示一条分隔线。菜单复用共享
ContextMenu 样式，保留深浅主题、键盘操作与窄屏定位能力。中英文均完整显示。
复制的是 URL，包含查询参数和片段，不是链接显示文字；复制不打开页面。
剪贴板不可用或写入失败时记录 UI warning，不产生未处理的 Promise rejection。

```text
右键链接 → 同一菜单
             ├─ 在 ZCode 中打开 → 现有 onOpenExternalUrl
             ├─ 在浏览器中打开 → 现有 platform.openExternal
             └─ 复制链接 → 当前客户端 navigator.clipboard
```

普通点击及 Ctrl/Cmd 点击的目标选择保持现有规则。无 Desktop PlatformProvider 的
Web 消费方保留既有打开回调；复制不要求 Desktop provider，不调用远端剪贴板。
本次只调整正文链接菜单，不调整预览卡片和文件链接菜单。

验收：MLC01 覆盖真实消息流右键、文案/图标/分组、两个打开目标及完整 URL 复制；
组件测试补充无 Desktop provider、复制失败和中英文；视觉检查使用 Zai Light /
Zai Dark 及宽窄布局。物理手机与 Windows/Linux 实机证据单独记录。
