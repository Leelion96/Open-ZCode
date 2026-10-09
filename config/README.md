# 客户端配置说明

本目录维护客户端随包发布的配置。修改对应 JSON 后，重新启动开发实例或重新构建发行包。

| 文件                                                       | 用途                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| [product.json](product.json)                               | 应用与 Agent 品牌、桌面身份、用户资料和项目资料隔离。                      |
| [default.json](default.json)                               | 反馈、社群等帮助入口的内置默认值。                                         |
| [provider/zcode-builtin.json](provider/zcode-builtin.json) | 供应商模板、模型与参数规则的随包基线，由已有 Provider 构建和运行入口读取。 |

## 产品品牌与隔离配置

修改 [product.json](product.json)，然后重新启动桌面或本机 Web 开发，或重新构建。配置只有名称、appId 和三个独立开关。

本文用 `New-Name` 作为品牌占位示例，派生标识为 `new-name`；`dev.newname.app` 是独立的 appId 示例。实际名称与 appId 以 `product.json` 为准，后续改品牌无需修改本文。

```json
{
  "name": "New-Name",
  "appId": "dev.newname.app",
  "customizeIdentity": true,
  "isolateUserData": true,
  "isolateProjectData": true
}
```

下文以此配置为例。名称统一派生小写标识 `new-name`；开关关闭时，对应类别保留上游默认值。

### 应用身份：`customizeIdentity`

| 内容                  | 上游默认           | 开启后                |
| --------------------- | ------------------ | --------------------- |
| 安装名称              | `ZCode`            | `New-Name`            |
| appId                 | `dev.zcode.app`    | `dev.newname.app`     |
| 外部协议              | `zcode://`         | `new-name://`         |
| Electron 资料根       | `<appData>/ZCode/` | `<appData>/new-name/` |
| Linux 包名 / 可执行名 | `zcode`            | `new-name`            |

`<appData>` 是 Electron 的系统资料目录，macOS 通常为 `~/Library/Application Support`。浏览器会话和缓存随资料根隔离，内部结构保持不变。Finder、Windows 右键、Linux 桌面入口及安装缓存等系统标识也随之隔离。

Preview / Dev 使用对应名称和身份后缀；profile 分别为 `new-name-preview` / `new-name-dev`。各形态仍共用 `new-name://`，协议后面的路由和参数不变。

### 用户级业务资料：`isolateUserData`

这个开关主要将用户级业务资料的默认根目录从 `~/.zcode/` 改为 `~/.new-name/`。原有内部结构、文件名和数据格式保持不变，只改变这些资料的默认归属位置。

目录内主要包括应用设置、账号凭据、会话数据库、日志和缓存，以及全局指令、技能、命令、插件、工作流和内嵌 Agent 的配置与运行资料。例如原有的 `v2/`、`cli/`、`skills/`、`workflows/` 等子目录，在新根目录下仍按原来的结构保存。

特殊情况：自定义数据根时，`<base>/.zcode/` → `<base>/.new-name/`；固定 HOME 的启动设置和全局资源不随 `<base>` 移动。内嵌 Agent 的用户目录程序候选也使用新根，随包程序名不改。

### 项目级配置与产物：`isolateProjectData`

这个开关主要将项目私有资料的默认目录从 `<project>/.zcode/` 改为 `<project>/.new-name/`，原有内部结构、文件名和格式保持不变。

目录内主要包括项目配置与指令、技能、命令、子代理和插件，以及工作流定义、草稿、运行产物、计划和记忆。例如 `config.json`、`AGENTS.md`、`skills/`、`workflows/`、`plans/` 等仍保留在对应位置，读写、监听、校验和清理同步使用新目录。

另外几个不位于该目录内的路径：

| 内容                     | 上游默认                     | 开启后                          |
| ------------------------ | ---------------------------- | ------------------------------- |
| 项目根配置               | `<project>/zcode.json`       | `<project>/new-name.json`       |
| 搜索忽略文件             | `<project>/.zcodeignore`     | `<project>/.new-nameignore`     |
| 分享附件目录             | `<project>/.zcode-share/`    | `<project>/.new-name-share/`    |
| 工作流写入失败的回落目录 | `<tmp>/zcode-workflow-runs/` | `<tmp>/new-name-workflow-runs/` |

`<project>` 是实际工作区目录，`<tmp>` 是系统临时目录。

### 使用边界

- 各开关独立：只改应用身份时，用户和项目业务目录仍保持上游默认。
- 不自动迁移、合并或清理官方资料；已有显式路径覆盖继续生效。
- 通用 `.agents/`、根 `AGENTS.md`、内部包名及兼容文件格式不改。
- 桌面及其内嵌 Agent、Web 前端/Server 及其启动的原 Agent 使用同一配置；普通独立 CLI、Computer Use Helper、远端运行组件和服务连接策略保持原有边界。本机 Web 规则见 [Web 产品配置一致性](../specs/features/web-product-configuration.md)。

## 内置帮助默认配置

`config/default.json` 是随客户端发布的默认配置，必须保留。Desktop 从打包文件读取，
Web 在构建时导入；远端请求失败或缺少有效字段时使用内置值。

### 帮助配置来源

新版社群和反馈入口请求当前 endpoint 的 `GET /api/v1/client/configs`，
读取 `data.configs.feedbackUrl`：

- `community_urls["zh-CN" | "en-US"]`：只按当前语言回退到内置入口，不跨语言回退。
- `feedback_url`：远端有效地址优先，否则使用内置地址。
- `feedback_use_external_form`：远端布尔值优先，`false` 也是有效覆盖。

请求携带 `app_version`；Desktop 另带 `platform-arch`，Web 省略平台参数。
成功响应仅做 1 小时内存缓存，请求使用 `cache: no-store`，失败不缓存。

```text
当前 endpoint client/configs -> 有效帮助字段 -> 平台入口
                  | 缺失 / 失败
                  v
          内置 default.json -> 平台入口
```

`default.json` 随客户端分发，不从 CDN 下载。它只提供帮助入口的默认字段，不是服务端 `configs.json` 的完整副本。
