# v3.18.1 合并边界

将上游 `c5904686ea8341826b3affe5d993d06a134fa779`（父提交 `b95ebaffeab641907b38652f45c1502bd762972d`）合入本地 `c9a5bec5`。采用正常双亲 merge，沿用 [v3.18.0 合并边界](upstream-v3.18.0-merge.md)；本地提交，不推送、不部署，不修改 Server 仓库。

## 产品与实现规则

- 保留五字段 `config/product.json`、品牌、身份、用户/项目资料隔离、自建可信更新源、普通公告、独立 Web、跳过登录及官方账号/套餐/Highspeed/遥测的既有裁决。两份模型配置本次无上游增量，保持原内容。
- 完整接入 Windows 安装进程清理与备份边界、麦克风权限恢复、流式摘要 React #185 修复、浏览器设计模式与分栏调整、macOS 字体平滑、手机返回导航、中国区 OAuth 回跳和 CLI 内存诊断。上游回归用例及候选状态一并保留，不恢复退役 App 业务单测。
- 新增自有提示通过现有 `{productName}` 国际化入口使用产品名称，覆盖五种语言；内部协议、存储 key、helper 名称及第三方内容不机械改名。麦克风重置读取当前 App 的真实 bundle ID，不重置其他应用。
- CLI 诊断默认目录与 Desktop full/compact 反馈和手动导出统一为既有产品用户根下的 `cli/memory-diagnostics`。复用 `PRODUCT_USER_DIRECTORY` 和现有路径入口，不增加配置源，不自动读取或迁移官方资料；显式 directory 参数优先，远端保持远端运行组件的配置。
- CLI adapter 唯一持有 inspector、采样与文件留存，bootstrap 只提供只读计数器并负责停止。保留上游采样、容量、锁和隐私预算，不把诊断错误传播到任务，不改变会话 owner/lease 或 desktop continuous / mobile replayable 语义。
- Windows 保留本地安装身份、清单名和更新信任规则；接入按完整映像路径与进程句柄校验的 helper 及其架构/签名/打包校验。helper 接受安装器传入的可选诊断日志路径，沿用现有产品身份派生的安装日志命名；未传时保持上游默认，不影响进程检查结果。备份失败继续安装，只有完整备份才允许恢复，提示与真实恢复能力一致。
- 手机 Shell 仅持有 home/chat 展示态；浏览器历史服务于刷新和前进后退，不改变 Host 连接、任务归属、序号或恢复协议。字体平滑仅为本机 UI 偏好，沿用广播防回环。

```text
构建产品配置 → 品牌 / 身份 / 产品用户根 → CLI 诊断写入 → full/compact 反馈与手动导出
app-server ready → adapter 采样与有界写盘；bootstrap stop → 停表、断开 inspector
旧安装目录 → helper 路径/句柄核验并确认退出 → 尝试完整备份 → 旧卸载器 → 新载荷
中国区浏览器中转 → 后端兑换 + App 唤起 → 原 flow polling 原子提交（迟到回调受代次保护）
手机返回箭头 → Shell home → 原位更新历史标记；Host / CLI 会话所有者保持不变
```

## 验收

- 检查内容冲突、15 个定制重叠路径及全部新增路径，核对产品配置、模型目录、更新源与新增品牌文字。
- 使用 `mise.toml` 固定的 Node / pnpm；执行根 typecheck、lint、架构检查、E2E 类型检查和相关工程门禁。复核改动 React 文件的 Hooks 告警，基础组件补做专项扫描。
- 执行 CLI typecheck/lint、内存诊断及 bootstrap 调用方定向回归；工程回归覆盖产品配置、构建、Windows helper 与 NSIS 编译。
- 运行流式摘要、字体平滑、来源描述和既有独立 Web 浏览器回归；诊断路径覆盖自定义名称及用户/项目隔离开关组合，并验证 full/compact 归档携带与过滤。
- 正常应用验收复用当前项目实例、用户资料与登录状态；故障文件仅用副本。真实手机、远端、macOS 打包权限和 Windows/Linux 实机未执行时明确记录，不把夹具当作实机证据。

## 实施与验证记录

2026-11-13：解决 5 个内容冲突（`.gitignore`、中英文 README、中英文字典），保留 fork 说明并更新源码版本，合并生成物忽略规则，接受上游新麦克风引导消息 ID 并接回 `{productName}`。15 个原有定制重叠路径及全部新增入口已核对；除本规格外，改动路径均在上游 111 文件内。

- `config/`、`packages/provider/`、`packages/provider-node/` 与合并前逐字相同，产品五字段、模型、更新源与既有产品裁决保持。麦克风重新授权按当前 App 的 Info.plist 读取 bundle ID，无须另造身份。
- 新诊断采集、full/compact 反馈与手动导出统一接入产品用户根。补充 CLI 目录回归覆盖自定义名称、四种资料隔离组合、显式 directory 优先及 stop 后不再写盘。Windows helper 新日志沿用现有身份命名，保留无第二参数的上游调用；回归加入自定义日志不触碰默认产品日志的场景。
- NSIS 编译首轮发现生成的产品日志宏与夹具显式路径重复定义。生成的日志默认值改为遵守已有宏，正式安装仍取原产品派生路径；重新生成后同一编译回归通过。中国区 OAuth E2E 的新协议断言使用公开产品解析器读取构建配置，不硬编码 `zcode://`。

本轮使用 Node 24.14.0 / pnpm 10.33.2；本机没有 mise 命令，使用已有缓存的固定 Node 和仓库 `mise-run.mjs`。主体证据位于 `packages/desktop/.e2e-artifacts/upstream-3181-merge/`。

- 冻结 lockfile 安装、根 `pnpm typecheck`、E2E 类型检查通过；根 lint 为 0 errors / 537 warnings。CLI typecheck 34/34 tasks 成功，CLI lint 为 0 errors / 86 warnings，另有 4 项原样上游行数诊断。
- 架构检查 0 violations；`pnpm test:architecture` 61/61 通过，未刷新 baseline。改动 UI 文件专项 Hooks 扫描包含根 lint 忽略的 reasoning 基础组件：27 个当前文件 28 条诊断，对应合并前 26 文件 30 条，按文件/规则/内容对比无新增，减少的两条属于摘要与 reasoning 的旧依赖诊断；其余为未改行上的既有问题，未批量补对象依赖或关闭规则。
- CLI 内存诊断 1 文件 15 项、bootstrap retention/V4 gateway 2 文件 116 项通过。工程 Vitest 共 3 文件 15 项最终通过：身份 13 项、NSIS section 1 项在首轮通过，编译 1 项在修复宏重复后重跑通过，不宣称首轮全绿。
- Node 工程组合 15 项中 14 项通过，1 个 Windows native helper 套件因平台跳过；包含构建配置、helper 无脚本编译依赖、Windows runtime host 构建策略与 Hooks 规则检查。该组合中的 Hooks 用例随后也被架构总入口覆盖，不重复累计为独立用例。
- 浏览器回归 19 项通过，覆盖生产 React 流式摘要与队列、字体平滑和跨窗口防回环、来源描述及既有独立 Web 任务列表（其中包含 5 个独立 Web 场景），包含桌面/窄屏、深浅主题与语言变化；没有将浏览器夹具当作真实手机网络回放。
- 真实 inspector 和 15 秒采样定时器的运行时验证在四种资料隔离组合下各生成有效记录，使用自定义名称和文件夹夹具；实际 full、compact 与手动收集函数都找到同一产品目录，反馈包过滤注入的正文/环境字段，隔离开启时不读取官方目录中的对照文件。仅替换 OS home 与 About/logger 边界，采样、文件存储和归档函数使用当前源码；结果见 `diagnostics-runtime-results.json`。
- schema 合同 8 项及两库兼容性通过。Agent 完整构建/桌面暂存、Desktop production 构建通过；保留已有大 chunk、动态 import 和插件耗时告警。新增规格、compact 入口、OAuth E2E 与 CLI 新增代码的定向格式检查、Git whitespace 检查通过，没有整库格式化。
- 正常 Open-ZCode Dev 44.7.0 复用现有 `open-zcode-dev` profile 和资料，页面来自当前仓库 `out/renderer/index.html`，既有项目/任务可见且跳过官方登录。字体平滑可关闭并恢复原开启偏好；项目菜单可点击搜索框输入并正常退出，未发送消息或修改项目。标准开发服务器端口被另一项目占用，未终止该实例；改用本仓库 production 产物与正常 Dev bundle，并为调试分配动态端口，未另建用户身份。自建服务未运行导致目录/公告请求连接拒绝，未把缓存页面当成联网服务验收。

未执行 Windows/Linux 实机（本机也没有 CMake/Windows 交叉编译器）、正式签名安装包、真实手机/SSH/WSL/Docker、打包版麦克风重授权和真实中国区 OAuth 验收；native helper 的自定义日志运行用例仍需 Windows 执行。未执行完整桌面 E2E，也未将合成采样视为内存泄漏已修复的证据。不推送、不部署，不修改 Server 仓库。
