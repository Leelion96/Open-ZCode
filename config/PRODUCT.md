# 产品配置

修改 `product.json`，然后重新启动桌面或本机 Web 开发，或重新构建。配置只有名称、appId 和三个独立开关：

```json
{
  "name": "Open-ZCode",
  "appId": "dev.openzcode.app",
  "customizeIdentity": true,
  "isolateUserData": true,
  "isolateProjectData": true
}
```

下文以此配置为例。名称统一派生小写标识 `open-zcode`；开关关闭时，对应类别保留上游默认值。

## 应用身份：`customizeIdentity`

| 内容                  | 上游默认           | 开启后                  |
| --------------------- | ------------------ | ----------------------- |
| 安装名称              | `ZCode`            | `Open-ZCode`            |
| appId                 | `dev.zcode.app`    | `dev.openzcode.app`     |
| 外部协议              | `zcode://`         | `open-zcode://`         |
| Electron 资料根       | `<appData>/ZCode/` | `<appData>/open-zcode/` |
| Linux 包名 / 可执行名 | `zcode`            | `open-zcode`            |

`<appData>` 是 Electron 的系统资料目录，macOS 通常为 `~/Library/Application Support`。浏览器会话和缓存随资料根隔离，内部结构保持不变。Finder、Windows 右键、Linux 桌面入口及安装缓存等系统标识也随之隔离。

Preview / Dev 使用对应名称和身份后缀；profile 分别为 `open-zcode-preview` / `open-zcode-dev`。各形态仍共用 `open-zcode://`，协议后面的路由和参数不变。

## 用户级业务资料：`isolateUserData`

这个开关主要将用户级业务资料的默认根目录从 `~/.zcode/` 改为 `~/.open-zcode/`。原有内部结构、文件名和数据格式保持不变，只改变这些资料的默认归属位置。

目录内主要包括应用设置、账号凭据、会话数据库、日志和缓存，以及全局指令、技能、命令、插件、工作流和内嵌 Agent 的配置与运行资料。例如原有的 `v2/`、`cli/`、`skills/`、`workflows/` 等子目录，在新根目录下仍按原来的结构保存。

特殊情况：自定义数据根时，`<base>/.zcode/` → `<base>/.open-zcode/`；固定 HOME 的启动设置和全局资源不随 `<base>` 移动。内嵌 Agent 的用户目录程序候选也使用新根，随包程序名不改。

## 项目级配置与产物：`isolateProjectData`

这个开关主要将项目私有资料的默认目录从 `<project>/.zcode/` 改为 `<project>/.open-zcode/`，原有内部结构、文件名和格式保持不变。

目录内主要包括项目配置与指令、技能、命令、子代理和插件，以及工作流定义、草稿、运行产物、计划和记忆。例如 `config.json`、`AGENTS.md`、`skills/`、`workflows/`、`plans/` 等仍保留在对应位置，读写、监听、校验和清理同步使用新目录。

另外几个不位于该目录内的路径：

| 内容                     | 上游默认                     | 开启后                            |
| ------------------------ | ---------------------------- | --------------------------------- |
| 项目根配置               | `<project>/zcode.json`       | `<project>/open-zcode.json`       |
| 搜索忽略文件             | `<project>/.zcodeignore`     | `<project>/.open-zcodeignore`     |
| 分享附件目录             | `<project>/.zcode-share/`    | `<project>/.open-zcode-share/`    |
| 工作流写入失败的回落目录 | `<tmp>/zcode-workflow-runs/` | `<tmp>/open-zcode-workflow-runs/` |

`<project>` 是实际工作区目录，`<tmp>` 是系统临时目录。

## 使用边界

- 各开关独立：只改应用身份时，用户和项目业务目录仍保持上游默认。
- 不自动迁移、合并或清理官方资料；已有显式路径覆盖继续生效。
- 通用 `.agents/`、根 `AGENTS.md`、内部包名及兼容文件格式不改。
- 桌面及其内嵌 Agent、Web 前端/Server 及其启动的原 Agent 使用同一配置；普通独立 CLI、Computer Use Helper、远端运行组件和服务连接策略保持原有边界。本机 Web 规则见 [Web 产品配置一致性](../specs/features/web-product-configuration.md)。
