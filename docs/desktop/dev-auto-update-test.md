# 桌面端开发态自动更新验证

## 目的

开发态默认不初始化自动更新，避免日常联调误触发下载、安装和重启流程。需要验证自动更新交互时，可以显式开启开发态自动更新，让 dev app 直接请求测试环境的服务端 manifest 接口。

测试环境已经提供：

```text
GET /api/v1/releases/electron/manifest
```

因此本地验证不再依赖 mock manifest server。

## 启动方式

```bash
ZCODE_AUTO_UPDATE_DEV=1 \
ZCODE_AUTO_UPDATE_DEV_VERSION=3.3.1 \
pnpm dev:desktop:test
```

- `pnpm dev:desktop:test` 会注入 `ZCODE_ENV=test`，manifest provider 会请求测试环境 endpoint。
- `ZCODE_AUTO_UPDATE_DEV=1` 只在开发态显式开启自动更新；未设置时保持开发态不检查更新。
- `ZCODE_AUTO_UPDATE_DEV_VERSION` 用于模拟当前客户端版本，例如当前版本按 `3.3.1` 比较，测试环境 stable 返回 `3.3.2`、preview 返回 `3.3.3` 时即可验证通道切换。

## 行为边界

- 生产包不读取这些开发态开关，仍按打包配置和服务端 manifest provider 检查更新。
- 自定义更新源只接受未打包开发态配置；`--` 后的开关一律忽略。更新源安全回归运行 `node packages/desktop/scripts/auto-update-source-security-smoke.mjs`，使用独立 Electron profile 与本机 HTTP 服务，只检查清单，不下载安装包。
- 该安全夹具显式启用更新器的 `forceDevUpdateConfig`，使普通 Linux Electron 在没有 `APPIMAGE` 时也能请求清单；仍保留每个场景的 `app.isPackaged` 值，不改变产品对打包态的判断。增加 `--appimage` 可在当前 Electron 宿主中强制选择真实 `AppImageUpdater`，覆盖其激活与请求路径；这不等于真实 Linux 安装或 AppImage 文件替换验收。
- `pnpm --filter @zcode/desktop test:auto-update-source-security-smoke` 依次执行默认更新器和 AppImageUpdater 的全部场景。CI 的 `test:auto-update-source-security` 使用已有 macOS E2E runner：更新器、manifest provider、深链解析、共享 endpoint 及其导出入口变更的 MR 自动执行，schedule 流水线也执行；release 目标 MR 和 schedule 使用仅包含此安全检查的独立 CI 配置，不启动打包、发布或业务 E2E；失败阻断，运行证据保留 7 天。该检查不使用已退役的 App 业务单测，不需要完整业务构建或真实账号。
- 开发态会设置 `electron-updater` 的 `forceDevUpdateConfig`，并读取 `packages/desktop/dev-app-update.yml` 作为本地缓存初始化占位；真实下载 URL 仍来自测试环境 manifest 响应。
- 开发态点击“重启以更新”只重启当前 dev app，用于验证 UI 状态闭环，不尝试让未打包应用接管真实安装器。
