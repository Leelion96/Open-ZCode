# Web 品牌与资料目录配置

## 产品规则与范围

Web 页面、HTTP Server 和它原来启动的 Agent 使用 `config/product.json` 的同一份五字段配置。仅统一自有品牌文字、用户及项目资料的命名空间；当前配置将 `.zcode`、`zcode.json`、`.zcodeignore` 等替换为对应的 `.open-zcode` 派生值。关闭某个隔离开关仍沿用该类上游默认，不迁移、合并或清理既有资料。

保持上游关系：Desktop 和本机 Web 共用业务及 Agent 源码，各自运行后台与 Agent 实例；手机远控继续复用桌面既有 Host attachment 和会话。owner/lease、workspaceIdentity、desktop-continuous 与 web-remote-replayable 语义均不变。

`pnpm dev:web` 保持原来的 Server/Vite 并行启动命令。保留原 Agent 查找顺序、启动参数、源码回退与既有 `dist/zcode.cjs` 产物位置；不新增 Web 专用 Agent、独立构建目录、准备命令或产品模式开关，不改变 test/production 的选择。

## 唯一配置来源与传递

Web Vite 和 HTTP tsup 构建复用 `loadProductConfig()`，注入既有 `__ZCODE_PRODUCT_CONFIG__`。HTML 初始标题使用同次读取的名称。构建期配置优先，非法配置阻断；修改配置后沿用原来的重新构建流程。

HTTP 入口将已校验的完整配置序列化为内部 `ZCODE_PRODUCT_CONFIG_JSON` 进程环境值，原 Agent spawn 环境继续自然继承它。未注入构建配置的 Agent/源码模式在共享解析入口校验该完整对象，并一次性派生名称和目录。该值只传递 Host 已读取的配置，不是新增人工配置源，不按字段合并，不保存第二份配置。

```text
config/product.json
  ├─ Web 构建 → 自有页面文字与路径展示
  └─ HTTP 构建 → 原 HTTP 入口 → 原 createLocalServices / 运行环境初始化
                                  ↓ 继承完整产品配置
                          原 Agent 查找与 spawn → 原 Agent 目录解析
```

独立 CLI 未收到应用配置时仍保留上游默认；Desktop 构建注入的配置保持原优先级。用户显式 Agent 命令及旧外部产物的选择规则不变，使用者负责其配置支持；本轮不改协议或引入新的版本协商。

## 保留的上游边界

HOME、显式目录、`ZCODE_DATA_BASE_DIR` 及服务 setter 沿用各消费者原有优先级。仅替换品牌命名空间，不新增 Web 提前读取桌面保存的 `dataBaseDir` 或复制桌面启动设置流程，不改变原资料迁移和目录选择行为。

品牌规则见 [应用品牌文字](application-brand-text.md)。分享继续链接复用已有桌面协议；下载地址保持空字符串并标记 TODO，空地址不展示链接，提示文案固定使用通用说明。共享机器人和远端工具错误使用通用文字，外部内容及业务占位符保持原文。

## 验收

- Web 开发/生产构建和 HTTP 构建读取同一产品配置，不需要额外启动标记。
- 原普通 CLI 产物及源码模式收到 Host 配置后使用自定义用户/项目目录；独立运行未收到配置时仍使用上游默认。
- 已注入配置优先于环境传递值；环境对象使用同一五字段校验，非法输入直接失败。
- 配置传递经过原运行环境清洗和 spawn 后仍生效；原命令选择、cwd、启动参数和环境准备保持不变。回归验证这些行为，不锁死初始化参数的全部键名。
- 用户/项目隔离开关分别生效；显式路径优先级不变，不写入或迁移官方资料。
- 执行品牌及隔离回归、root typecheck/lint、架构检查和 Web/HTTP 构建；复用真实资料验证页面与实际资料位置，不发起付费推理。
- 完整发行包、手机远控和跨平台未实际执行的项目如实记录，不把上游已有问题纳入修复。

## 验收记录（2026-10-09）

- 品牌、产品身份、用户及项目目录共 34 项回归通过；覆盖普通 CLI 产物、源码模式、配置校验与原 HTTP/Agent 查找及环境继承链路。
- root typecheck、架构检查通过；按原有源码格式和换行维护差异，不运行自动重排。Lint 为 0 错误、70 条存量警告；附加 UI 静态审计的 39 项命中均在未修改文件，未扩展修复范围。
- 原 CLI 构建命令、Web 构建、HTTP 构建通过。`pnpm dev:web` 使用原并行启动流程，没有额外产品模式和 Agent 预构建步骤。
- 复用现有用户资料，页面标题显示自定义品牌；通过进程打开文件确认 HTTP Server 使用 `<HOME>/.open-zcode/v2/tasks-index.sqlite`，原 `dist/zcode.cjs` Agent 使用 `<HOME>/.open-zcode/cli/db/db.sqlite`。未发起模型推理或保存用户设置。
- 目录控件、默认套餐占位等 UI 已恢复原样；上游 Web 总任务列表的 `window-controller` 缺失等问题未修改。未执行完整发行包组装、手机远控或跨平台验收。
- 验证使用 Node 24.18.0、pnpm 10.33.2，未修改仓库锁定的工具链版本。
