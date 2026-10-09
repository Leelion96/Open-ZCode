# Open-ZCode

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="Open-ZCode" width="128" height="128" />
</div>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

本项目fork自开源 [ZCode](https://github.com/zai-org/ZCode) ，旨在为想将ZCode作为AI提效工具的团队提供快速接入能力。

当前已实现的改动可分为三大类：

1. **和官方ZCode保持隔离**：品牌名、应用身份、用户资料、项目产物通通和官方ZCode区别开来，互不影响。
2. **自建 [Open-ZCode-Server](https://github.com/Leelion96/Open-ZCode-Server) 服务，接管项目内各类上游服务能力**：目前已实现配置下发和插件市场；登录、分享、反馈、更新等业务暂未实现，相关 API 为占位接口。
3. **调整官方服务与商业入口**：关闭审计上报、官方授权登录及商业套餐等入口。

## 改动原则

在介绍具体实现之前，我想先说明，**我是如何修改这个项目的**：

对开源项目进行二次开发时，随着与上游代码的差异不断积累，后续合并上游版本更新内容时，处理冲突的成本也会越来越大。（除非你是一锤子买卖，fork完就再也不管上游更新了）

所以本项目基于尽量减少未来合并冲突的理念，遵循以下最小改动原则：

- **尽量保持上游接口，通过自建服务承接差异**
  对于配置、模板、插件目录等服务下发内容，优先让自建 Server 兼容已有接口和数据结构，客户端沿用原来的请求、解析与使用方式，减少客户端业务代码的修改。

- **关闭功能时，优先使用配置开关或调整入口**
  对于官方授权、商业套餐等不需要的功能，优先关闭相应开关或入口，尽量保留已有实现和其他功能依赖的公共能力，避免连带删除大量业务代码。
- **每个提交只解决一类明确需求，方便独立审查和取舍**  
  如品牌调整、应用身份隔离、用户资料隔离、项目资料隔离等分别提交。每个提交尽量形成完整的改动闭环，不夹带无关重构或格式调整，方便按需保留或回退。

## 改动内容

以下对照以上游 ZCode **3.14.3**（`29628c9`）为基线，当前实现以默认桌面产品配置为例。

| 改动主题                         | ZCode 上游实现                                               | 当前实现                                                     |
| -------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 应用身份与系统入口隔离           | 正式应用使用 `dev.zcode.app`、`zcode://` 协议及 ZCode 的 Electron profile 和系统注册标识 | 使用 `dev.openzcode.app`、`open-zcode://` 协议及独立 profile；同步隔离 Finder、Windows 右键和 Linux 桌面入口，保留 Preview / Dev 区分 |
| 用户资料与内嵌 Agent 隔离        | 用户资料默认位于 `~/.zcode/`，内嵌 Agent 使用其下的配置、运行资料与程序候选路径 | 默认使用 `~/.open-zcode/`，同步设置、凭据、会话、日志和全局资源；保持内部结构与显式路径优先级，不自动扫描或迁移官方私有资料 |
| 项目配置与产物隔离               | 使用 `.zcode/`、`zcode.json`、`.zcodeignore`、`.zcode-share/` 等项目路径 | 使用 `.open-zcode/`、`open-zcode.json`、`.open-zcodeignore`、`.open-zcode-share/`；同步读写、监听、权限及清理，保留通用 `.agents/` 和根 `AGENTS.md` |
| 应用品牌文字                     | 应用界面、原生窗口、系统入口及内嵌 Agent 使用 ZCode 品牌文字 | 需要明确应用身份的自有文字使用配置名称 `Open-ZCode`，覆盖窗口、菜单、Agent、进程展示及新生成资料 |
| 通用文案精简                     | 部分错误提示、内部提示词和能力说明包含 ZCode 品牌主体        | 按原语义省去不必要的品牌主体，使用会话、运行时、Agent 等具体称谓，同步中英文及历史错误识别 |
| 关闭官方授权登录与套餐与权益入口 | 默认启用 BigModel / Z.ai OAuth，欢迎页提供授权登录与 API Key 配置入口<br />模型设置展示官方个人、团队套餐及权益状态，侧栏提供套餐升级入口 | 默认禁用两类 OAuth，欢迎页可直接跳过登录，模型设置改为默认套餐占位和自定义供应商，隐藏官方套餐、额度展示及升级入口 |
| 产品配置与模板下发（配套服务）   | 默认连接官方产品服务；已有 `ZCODE_BASE_URL` 地址覆盖入口，下发功能配置、供应商和场景模板 | 沿用 `ZCODE_BASE_URL` 接入 Open-ZCode-Server，维护自有配置、供应商模板、草稿推荐与定时任务模板；登录、分享、反馈和更新业务仍为占位接口 |
| 客户端交互追踪（服务配置）       | 通过产品服务下发的 `rendererActionTrace` 配置控制交互追踪    | 自建 Server 明确关闭交互追踪及相关采样；其他遥测仍遵循各自配置，不表示全部上报能力均已关闭 |

注：本表主要说明桌面端及内嵌 Agent 的改动。独立 CLI / Web 的发行身份尚未单独定制，共享源码中的文案、网络修复和市场配置会沿用同一份实现。产品服务和交互追踪条目说明配套 Server 的配置；插件市场条目包含当前尚未提交的客户端本地改动。

## 快速开始

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下开发和打包命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

准备好自建 Server 的 HTTPS 地址后，在 macOS / Linux 中启动桌面端：

```bash
ZCODE_BASE_URL=https://your-server.example.com pnpm dev:desktop
```

Windows PowerShell：

```powershell
$env:ZCODE_BASE_URL = "https://your-server.example.com"
pnpm dev:desktop
```

示例地址需替换为自己的部署地址。进程环境变量优先，确保桌面构建的各入口使用同一服务地址；也可按下方“配置”章节维护环境文件。修改构建配置后需重新启动开发或重新构建发行包。首次进入应用可跳过登录，再在模型设置中配置自己的 API Key 和 endpoint。

## 品牌与隔离配置

[config/product.json](config/product.json) 是桌面与本机 Web 产品的唯一配置入口：

```json
{
  "name": "Open-ZCode",
  "appId": "dev.openzcode.app",
  "customizeIdentity": true,
  "isolateUserData": true,
  "isolateProjectData": true
}
```

| 字段                 | 作用                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| `name`               | 应用与内嵌 Agent 的品牌文字；名称也用于派生已开启隔离类别的标识与目录 |
| `appId`              | 应用身份隔离开启时使用的桌面 appId                                    |
| `customizeIdentity`  | 隔离安装身份、外部协议、Electron profile 和系统入口                   |
| `isolateUserData`    | 隔离用户级业务资料与内嵌 Agent 的默认用户目录                         |
| `isolateProjectData` | 隔离项目级配置、忽略文件、分享附件与运行产物                          |

三个开关独立控制，关闭某项时该类别使用上游默认规则。名称或开关变化后需要重新启动桌面开发或重新构建；不会自动迁移、合并或清理官方资料。详细规则及显式路径覆盖的边界见 [桌面产品配置](config/PRODUCT.md)。

## 开发与运行

### 初始化选项

根据需要选择其他初始化或构建入口：

| 命令                           | 用途                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `pnpm install`                 | 安装依赖                                                          |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源，默认包含远程资源准备                            |
| `pnpm prepare:remote-assets`   | 单独准备远程运行资源                                              |
| `pnpm bootstrap:with-remote`   | 初始化依赖、本地与远程资源，并串行构建相关包；跳过桌面应用 bundle |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤         |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发。使用远程工作区或验证远程发行资源时，再运行对应准备命令。

### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，设置 `ZCODE_ENV=production`；实际服务地址由 endpoint 配置决定。切换 `test` / `production` 不会自动切换到自建服务。启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 和源码监听。

需要独立开发数据目录时，可设置 `ZCODE_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.open-zcode-dev-home" pnpm dev:desktop:test
```

### 远程功能（SSH/WSL）

先执行 `pnpm bootstrap:with-remote` 准备远程资源（mock-cdn），再 `pnpm dev:desktop`；连接远程项目时资源选择「本地下载后上传」。开发态资源取自本地 `packages/desktop/mock-cdn` 和本地构建产物，经 SFTP 上传到远程，不访问 CDN。

### Web 开发

修改 Web 或后端源码时，使用开发模式：

```bash
pnpm dev:web

# 指定后端工作区（macOS / Linux）
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

该命令同时启动 Web 开发服务器（默认 `http://localhost:5173`）和后端（默认 `http://localhost:3030`）；浏览器访问前者。`/ws` 和一般 `/api` 请求代理到本地后端，`/api/v1/oauth/token` 单独代理到当前配置的产品服务。

Web 页面、后台和后台启动的原 Agent 使用 `config/product.json` 的品牌与用户/项目目录配置。启动命令、Agent 查找顺序和资料目录优先级沿用原有方式，不另建 Web 专用产物或自动构建步骤。

Agent 源码修改后，执行 `pnpm --filter @zcode/cli... build` 并重启服务。需要验证完整发行包时，按下方“ZCode 命令行版”打包章节解压运行。

### ZCode 命令行版

命令行发行包包含 TUI、Web 和 Agent，统一使用 `zcode` 启动：无参数进入 TUI；第一个参数为 `--web` 时启动 Web；其他参数交给现有 Agent CLI 处理。两种模式都在本机运行，无需 Electron。

```bash
# 默认进入终端交互界面
zcode

# 启动 Web 界面
zcode --web

# 指定项目和端口，不自动打开浏览器
zcode --web --workspace /path/to/project --port 3030 --no-open

# 查看 CLI 或 Web 参数
zcode --help
zcode --web --help
```

Web 模式默认工作目录为当前目录，监听 `127.0.0.1`，默认不启用访问令牌，自动选择空闲端口并打开浏览器。访问终端输出的地址，按 `Ctrl+C` 停止服务。局域网访问可使用 `--host 0.0.0.0`；监听非本机地址时默认生成访问令牌，使用终端输出的带令牌链接。可通过 `--token` 指定令牌或 `--no-token` 关闭令牌认证。

直接启动通用 Web 服务的 HTTP 入口时，通过 `ZCODE_SERVER_AUTH_TOKEN` 配置 API／WebSocket 认证；通过程序接口创建服务时，使用 `authToken` 选项。

构建方式见下方打包章节。`pnpm build:zcode` 只生成发行包，不会替换 `PATH` 中已有的 `zcode`。如果命令仍指向旧安装或其他源码目录，macOS / Linux 可用 `command -v zcode` 检查，Windows 可用 `where.exe zcode` 检查。

### CLI 源码开发

直接开发 TUI 或 Agent 时，运行源码入口：

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# 构建 CLI 及其 workspace 依赖
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

这个入口直接运行 Agent CLI，不经过发行包的 `--web` 分流。开发 Web 用 `pnpm dev:web`；验证统一的 `zcode` 命令，用下方解压后的 `bin/zcode.mjs`。

## 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，其中保留上游地址供参考。首次配置且尚无 `.env` 时可复制；已有本地配置请保留。桌面构建读取 `.env`、`.env.local` 及对应构建模式的环境文件；模式文件可覆盖通用文件，进程环境变量优先。Desktop 的产品环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `ZCODE_BASE_URL`                     | 产品服务 origin，例如 `https://your-server.example.com`；不包含 `/api/v1`                            |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录；当前桌面配置写入其下的 `.open-zcode/`，未注入产品配置的独立 CLI / Web 使用 `.zcode/` |
| `ZCODE_SERVER_WORKSPACE`             | Web 后端的工作区路径                                                                                 |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置                                                     |
| `ZCODE_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址                                                                       |

CDN、远程资源、分享页面回链和第三方模型服务有各自的地址配置，不能仅凭 `ZCODE_BASE_URL` 推定全部网络请求已切换。各变量见 [.env.example](.env.example)，随客户端发布的默认配置见 [config/README.md](config/README.md)。

## 打包

第三方版权与许可材料见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，构建发行物时需一并保留对应声明。

### 桌面版

```bash
pnpm bundle:desktop

# 指定目标平台与 CPU 架构
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

默认目标为 macOS arm64，默认输出目录为 `packages/desktop/dist/`。`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`；实际打包与签名需要目标平台对应的工具和配置。

以当前默认品牌为例，双击打开产物 DMG，将 Open-ZCode 拖入“应用程序”。本地构建未签名，首次打开若被 macOS 拦截，可针对自己的构建产物执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Open-ZCode.app
```

### ZCode 命令行版

构建入口为 `pnpm build:zcode`。脚本会依次构建 CLI/TUI、后端和 Web，收集 TUI 的原生库、worker 与运行时依赖，再组装发行包；运行发行包仍需要 Node.js，版本以 `mise.toml` 为准。

打包前必须设置下载根地址 `ZCODE_DIST_BASE_URL`（可放在 `.env`、`.env.local` 或环境变量中），也可以通过 `--base-url` 传入。以下地址是占位示例，发布时替换为实际托管地址：

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# 已配置 ZCODE_DIST_BASE_URL 时
pnpm build:zcode

# 仅重新组包，复用已有的 Agent、后端和 Web 构建产物
pnpm build:zcode --skip-build

# 查看版本、输出目录等可选参数
pnpm build:zcode --help
```

默认版本取根目录 `package.json`，输出目录为 `dist/zcode/`：

- `releases/<version>/zcode-<version>.tar.gz`：运行包。
- `releases/<version>/sha256.txt`：校验摘要。
- `latest.json`、`install.sh`：版本索引和安装脚本。

完整目录可上传到配置的下载根地址。安装脚本从该地址下载运行包，默认安装到 `~/.zcode/runtime`，并在 `~/.local/bin` 创建 `zcode` 命令。安装目录可通过 `ZCODE_DIST_HOME` 修改，命令目录可通过 `ZCODE_DIST_BIN_DIR` 修改。

旧 Lite 用户需要改用上述构建命令、环境变量和新的安装脚本。新安装不会删除旧 Lite 目录，也不会迁移或删除已有会话数据。

本地调试打包产物时，可直接解压运行，无需上传或安装：

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" \
  -C dist/zcode/debug
# 默认启动 TUI
node dist/zcode/debug/zcode/bin/zcode.mjs

# 启动 Web
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

浏览器打开 `http://127.0.0.1:3030`，即可验证同一后端服务托管 Web 页面和 Agent 的完整链路。该端口需要空闲；如正在运行 `pnpm dev:web`，可改用其他 `--port`。

## 仓库结构

| 目录                                                 | 职责                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包   |
| `packages/web`                                       | Web 客户端                                 |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接            |
| `packages/zcode-server-cli`                          | 独立 Server 启动与进程管理                 |
| `packages/ui`                                        | 共享 React 组件、hooks 与 Zustand 状态     |
| `packages/services`                                  | 业务服务与持久化                           |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议和类型、RPC 框架、Agent 客户端 SDK |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现              |
| `apps/zcode-cli`                                     | Agent CLI、TUI、运行时与工具               |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明材料     |

## 当前范围与上游关系

当前源码基于上游 ZCode **3.14.3**。本项目独立维护，保留上游来源署名、内部包名、协议字段和兼容文件格式。

- 品牌与资料隔离配置覆盖桌面端及内嵌 Agent。独立 CLI / Web 的发布身份、Computer Use Helper 与远端运行组件不在本轮隔离范围内；独立命令仍为 `zcode`。
- 品牌改动覆盖自有文字，Logo、图标保留现状；第三方与用户内容保留其来源。现有资料不会自动迁移，详细规则见 [应用品牌说明](specs/features/application-brand-text.md)。
- `ZCODE_BASE_URL` 选择产品服务入口；Server 当前能力、其他地址配置和客户端回退行为共同决定实际运行范围。
- Windows / Linux 的适配器验证不等于真实安装、卸载和签名验收，详见 [产品隔离验收](specs/features/product-isolation-verification.md)。

上游项目与社群：[ZCode 源码](https://github.com/zai-org/ZCode) · [上游飞书社群](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&qr_code=true) · [上游 Discord](https://discord.gg/z9aBcQXZQ3)。这些入口属于上游项目。

## 许可与项目声明

第一方代码采用 [Apache-2.0](LICENSE)。能力范围、维护规则、执行与数据风险及第三方版权说明见 [NOTICE.md](NOTICE.md) 和 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；第三方组件与资源遵循各自的许可。
