# 产品配置基础设计

状态：配置基础已实现；应用身份、用户资料和项目资料消费端按后续提交接入。

## 目标与范围

fork 后一次性配置桌面产品。仅提供一个名称、一个 appId 和三个开关，统一派生应用身份、用户资料、项目资料所需值。三类可独立选择，关闭时保留该类当前上游默认行为。

内嵌 Agent 的程序查找与用户资料归入用户资料，项目产物归入项目资料。不处理独立 CLI 安装发布、Computer Use Helper、远程运行组件、更新分发或外部连接策略；本配置也不实现这些能力的禁用。

## 唯一配置入口

配置入口 config/product.json：

```json
{
  "name": "Open-ZCode",
  "appId": "dev.openzcode.app",
  "customizeIdentity": true,
  "isolateUserData": true,
  "isolateProjectData": true
}
```

无版本字段、分组对象、独立路径覆盖、逐字段环境变量、多层合并、迁移或热更新体系。三个开关必须显式填写布尔值，name 和 appId 为非空字符串。

## 统一派生

name 用作安装名称；派生 key 时去掉首尾空格、转为小写、将连续空白转换为一个连字符。例如 Open-ZCode 对应 open-zcode。第一版只接受能按这个简单规则产生安全小写 ASCII slug 的名称，不静默删除其他字符来凑标识。中文或特殊字符显示名如以后需要另行扩展，本轮不新增 key 字段。

| 用途                                  | 三组开启时的结果                                                      | 所属开关           |
| ------------------------------------- | --------------------------------------------------------------------- | ------------------ |
| 安装名                                | Open-ZCode                                                            | customizeIdentity  |
| 正式 / Preview / Dev appId            | dev.openzcode.app / dev.openzcode.app.preview / dev.openzcode.app.dev | customizeIdentity  |
| 外部协议                              | open-zcode://                                                         | customizeIdentity  |
| 可执行名、包名、系统入口归属          | 按 open-zcode 和 appId 派生                                           | customizeIdentity  |
| 正式 / Preview / Dev Electron profile | 按 open-zcode、open-zcode-preview、open-zcode-dev 派生                | customizeIdentity  |
| 用户私有根                            | <HOME>/.open-zcode                                                    | isolateUserData    |
| 可迁移业务根                          | <dataBaseDir>/.open-zcode                                             | isolateUserData    |
| 启动设置                              | <HOME>/.open-zcode/v2/setting.json                                    | isolateUserData    |
| Agent 用户目录程序候选及默认资料      | 使用 .open-zcode 下既有子结构                                         | isolateUserData    |
| 项目私有根                            | <workspacePath>/.open-zcode                                           | isolateProjectData |
| 项目根配置                            | open-zcode.json                                                       | isolateProjectData |
| 项目忽略文件                          | .open-zcodeignore                                                     | isolateProjectData |
| 项目分享目录                          | .open-zcode-share                                                     | isolateProjectData |
| 工作流临时回落                        | <tmp>/open-zcode-workflow-runs                                        | isolateProjectData |

v2、cli、skills、workflows 等内部结构保持原样。系统归属标记、安装清单、安装日志及开发缓存等只按身份开关取值；未开启身份改造时保持原规则。

## 开关独立

共用名称不意味着三类自动开启。每组结果都独立执行“开关开启则使用派生值，关闭则沿用上游原规则”。不允许凭名称已填写推断用户/项目隔离已开启。

例如仅 customizeIdentity 为 true 时：安装身份和协议使用 Open-ZCode/open-zcode，用户资料仍为上游默认，项目仍使用 .zcode 和 zcode.json，应用内品牌文字与图标仍沿用上游。

关闭资料隔离就意味着允许共享上游资料；这是用户选择，不拒绝构建，也不能宣称对应类别已隔离。HOME 被当作项目时仍按当前用户/项目作用域分别解析。

## 读取和接入

```text
name + appId → 简单派生规则
             → 三个开关分别选择：派生值 / 上游原规则
             → 构建、安装器、Desktop、Host、Agent、UI 一致消费
```

固定配置文件，在开发/构建入口读取。复用 shared 公共入口提供纯配置结果，Node-only 路径解析通过 shared/node；按现有打包方式适配 JSON 或编译期注入。NSIS 由构建入口传入对应值，不维护第二份人工配置。

不新增配置 Service、store、数据库、配置版本、摘要或用户需手动管理的生成流程。关闭组复用上游规则，不用统一框架重写原本有意不同的默认路径。

显示名称和命名空间在本方案中有意绑定。以后修改 name 并重新构建，会改变所有已开启类别的派生值；没有自动迁移。此方案以 fork 后一次性配置为前提，不另加稳定标识字段。

## 数据和 Agent 不变量

资料开关仅改变默认产品私有位置，保留 HOME、dataBaseDir、workspacePath 的区别，以及既有 setter、参数、环境变量、显式 storage/config/log 路径的优先级。不重写真实 HOME，不新增迁移，不扩大原有 v2-only 复制范围。

随包/当前仓库 Agent 保持原程序来源顺序。isolateUserData 开启时用户目录候选转到新根，不自动回落官方私有路径；关闭时原候选保留。内嵌 Agent 源码虽位于 apps/zcode-cli，桌面所需路径仍属于本轮。

项目开关同步覆盖发现、读写、删除、监听、相对 cwd、权限、清理和失败回落，仅改路径不改配置层级。路径提示使用实际生效值。

通用 .agents、根 AGENTS.md、显式旧配置、内部 @zcode/\* 包名、业务协议、数据库格式和兼容插件格式保留。不盲目替换用户内容、第三方名称、代码或来源声明。

## 最小校验与验收

检查五个字段的类型、名称派生结果、appId、目标平台路径安全。没有配置版本或复杂兼容框架。测试不把关闭类别的官方默认判为错误。

本轮验收三类全开，覆盖配置派生、系统注册、用户资料读写、项目发现与权限边界、失败回落。关闭及单开场景不执行；不以源码字符串匹配代替行为验证。

保持当前正式/Preview/Dev 的选择及业务资料/scheme 共享关系，不新增跨形态策略。按配置基础及三类分批实施，参考指定三次提交各自 diff，不带入其前后无关行为。

源码依据：packages/desktop/scripts/desktop-product-identity.mjs、packages/desktop/src/main/desktopRuntimeEnv.ts、packages/services/src/paths.ts、packages/services/src/runtime-tools/providerRuntimeResolver.ts、packages/shared/src/workspace-hook-config.ts、packages/ui/src/i18n/locales/zh-CN.ts。feature graph 尚缺产品配置种子，实现后按真实文件和符号更新。


## 最小必要改动原则

用户明确要求参考提交仅作查漏，不能作为照搬文件清单。不全盘替换字符串，不顺便格式化、重构或统一现有布局；尽量保留原来的符号名、文件名、代码风格和换行。

### 接入位置的优先级

1. 优先改现有公共解析函数和领域常量，保持导出名与调用方式，消费者自然获得新值。
2. 没有共同入口时，只在构造具体路径、注册系统身份、生成/校验链接的边界处取产品值。
3. 只有存在独立校验、监听、删除、相对路径推导等消费者时，才扩大接入；不能为少改文件而漏掉这些行为。
4. 业务内部算法、配置优先级、事件顺序、数据库格式、对象所有权和应用架构均不随产品隔离改造。

原来的上游默认值应尽量留在原位置，关闭时直接复用原值或原函数。公共产品模块只负责自定义值和开关，避免在新文件复制整套上游默认定义；否则未来上游修改时会出现第二个维护点。

### 已确认可利用的入口

| 入口                                                                    | 建议改法                                           | 下游可保持不变的范围                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| packages/desktop/scripts/desktop-product-identity.mjs                   | 现有身份解析增加自定义选择，保留 flavor 和环境规则 | 已通过身份解析消费 appId/名称/可执行名的打包代码                 |
| packages/services/src/paths.ts                                          | 数据根和复制源/目标接入用户目录名                  | 已使用 getAppConfigDir/getZCodeDataRootDir 的数据库、Repo 和服务 |
| apps/zcode-cli/packages/contracts/src/tools/saved-workflow.ts           | 更新现有目录常量的取值，不改导出名                 | 已消费 WORKFLOW_DRAFTS_DIR 等常量的保存、列出和权限代码          |
| apps/zcode-cli/packages/adapters/src/skills/roots.ts、commands/roots.ts | 按现有 scope 分别选用户/项目目录，保留发现顺序     | 已使用根解析结果的枚举和业务处理                                 |
| packages/ui/src/i18n/IntlProvider.tsx                                   | 向格式化入口统一提供路径占位值                     | 已经通过 formatMessage 获取文案的组件调用                        |

不因此修改独立 CLI 分发。共享常量若还被独立 CLI 消费，应按现有桌面构建边界确保独立 CLI 构建继续得到上游默认，不能因为源码共享而主动扩大产品改造范围。

### 必须另外接入的消费点

- 身份：硬编码协议的注册/解析/生成、Dev bundle 元数据、Windows/Finder/Linux 系统归属、Electron profile 和必要安装保护；已经使用统一身份结果的部分不重复改。
- 用户资料：绕过 services/paths 的启动设置、硬件加速读取、固定 HOME 全局资源、Agent 默认配置和用户目录程序候选。复用入口不等于所有硬编码已自动覆盖。
- 项目资料：根配置/隐藏配置发现、忽略文件、分享目录、记忆和临时回落，以及未消费公共目录常量的独立读写与校验。

例如 workspace-hook-config 的 configFileKind 虽然字面量像路径，其当前用途涉及来源类别、信任摘要和 mutation 判断。实施前需验证是否可以保留既有语义标识、只改变真实路径；不得因看见 zcode 字样就直接改协议 enum。若实际契约要求变更，才同步改类型、schema 和消费者，并记录原因。

### 明确不改

- 内部包名、类/函数名、协议字段和历史语义标识，不为品牌统一而批量改名。
- 插件兼容格式、第三方标识、供应商图标、用户内容和来源说明。
- 已经使用改造后的公共根/常量，且没有独立路径假设的下游实现。
- 同一产品子目录的数据库名、日志文件名及随机临时文件前缀，除非存在实际共享、覆盖或清理冲突。
- 非本轮能力的安装、发布、远端、Helper、服务连接和业务逻辑。
- 全仓 README/历史注释/提示词字符串清理。只更新本次真实变更的说明及会指导错误文件读写的活动提示。
- shell 检查脚本若已有显式路径参数，先用参数保持可用，不仅为展示名称改动脚本；确有自动构建依赖该默认值时再接入。

### 差异审查和验证

每个拟改文件先写清改动理由：定义、真实消费、校验/监听/清理、用户可见提示、构建必要接入或行为测试。说不出理由的改动不做。实施清单按批次逐步确认，不提前承诺文件数量。

每批审查 git diff，剔除无关换行、import 重排、变量改名、整文件格式化和无关功能调整。直接相邻的错误注释应修正为默认/条件语义，不能为了减 diff 留下会误导当前行为的说明。

不为隐藏检查失败增加 baseline、忽略规则或类型豁免。本轮仅验收三类全开的实际读写、注册和权限，不以源码字符串匹配作为主要正确性证据。最终还需运行正常桌面流程，不能只证明新配置解析成功。
