# 14: 旧同步入口统一与旧弹窗删除

Status: done

**Parent:** [数据同步：把本机配置推送到远端设备](../../remote/data-sync.md)

**What to build:** 原有的 6 处同步入口全部改为打开新的数据同步弹窗，并定位到对应的设备和分类，让同一种同步只有一套界面和一种行为。从连接向导、Header 或侧栏项目菜单进入时，弹窗知道当前项目，MCP 推送因此也会按项目映射 workspace 路径。从设置页进入时，MCP 推送只做 home 改写。SSH、WSL、Docker 三种远程项目都显示这些入口。旧的技能、MCP、插件三个同步弹窗及其专用逻辑删除。

**Blocked by:** [06: MCP 服务器分类](06-mcp-category.md)、[07: inline 插件分类](07-inline-plugin-category.md)、[08: marketplace 插件分类](08-marketplace-plugin-category.md)

| 入口                            | 打开的设备              | 初始分类                    | workspace 映射 |
| ------------------------------- | ----------------------- | --------------------------- | -------------- |
| 连接向导「一键同步」下拉        | 刚连接的设备            | 所选项（技能 / MCP / 插件） | 有             |
| Header 更多菜单                 | 当前 workspace 所在设备 | 所选项                      | 有             |
| 侧栏远端项目菜单                | 该项目所在设备          | 所选项                      | 有             |
| 技能、MCP、插件设置页的同步按钮 | 当前目标设备            | 对应分类                    | 无             |

## Acceptance criteria

- [x] 6 处入口都打开新弹窗，传入设备和初始分类；有项目上下文的入口同时传入本机与远端的 workspace 路径，MCP 推送据此做 workspace 改写。
- [x] 技能、MCP、插件设置页的入口不传 workspace 路径。MCP 设置页入口只做 home 改写，不做 workspace 改写。
- [x] 连接向导、Header、侧栏项目菜单入口的显示条件覆盖 SSH、WSL、Docker 三种远程 tab（设置页按钮的条件在 15 调整）；入口只在设备在线时可用，不会为了显示入口而建立连接。
- [x] 入口从 tab 的 workspace identity 解析 sourceServerId（`getWorkspaceSourceServerId` 或 `parseRemoteWorkspaceIdentity`）。旧格式远程 tab 解析不出 sourceServerId 时，不显示入口。
- [x] 删除旧的技能、MCP、插件同步弹窗，以及只为它们服务的辅助代码和「列出远端状态」类旧接口。写权限预检、刷新逻辑、marketplace 编排已在前序票中迁入新结构，本票不重写。
- [x] 旧弹窗的单测删除或迁移到新弹窗的 seam。引用旧入口的 E2E（包括 WPL-011）改为断言新弹窗，并同步更新 case 目录与覆盖矩阵。
- [x] 在旧的技能、MCP、插件三份同步 spec 中标注被数据同步规格取代的部分；修正 MCP spec 中过期的 `enable` 字段描述。
- [x] 先补测试再改代码。

## Verification

- Seam ②：每个入口打开的弹窗都定位到正确的设备和分类；有项目上下文时，MCP 比较使用 workspace 改写后的配置；从 MCP 设置页进入时只做 home 改写；Docker 远程 tab 显示入口；旧格式远程 tab 不显示入口。
- Seam ③：分别从 6 处入口打开弹窗，断言是新弹窗、设备和分类正确；全局搜索确认旧弹窗组件已无引用。
