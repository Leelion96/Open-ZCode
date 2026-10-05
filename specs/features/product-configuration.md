# 产品配置基础设计

## 目标与范围

fork 后一次性配置桌面产品，用一个名称、一个 appId 和三个独立开关派生应用身份、用户资料及项目资料的位置。应用品牌文字默认使用名称，没有开关；具体规则见 [应用品牌文字](application-brand-text.md)。

范围包含桌面端及内嵌 Agent。Agent 的用户资料和程序查找归入用户资料，项目运行产物归入项目资料。不扩展独立 CLI/Web 的安装发布、Computer Use Helper、远程运行组件、更新分发或外部连接策略，也不通过本配置禁用这些能力。

## 唯一配置入口

`config/product.json`：

```json
{
  "name": "Open-ZCode",
  "appId": "dev.openzcode.app",
  "customizeIdentity": true,
  "isolateUserData": true,
  "isolateProjectData": true
}
```

只接受这五个字段。三个开关必须为布尔值；名称和 appId 去除首尾空格后不能为空。不增加版本、品牌开关、路径覆盖、逐字段环境变量、多层合并、配置 Service、热更新或自动迁移。

名称仅接受单行 ASCII 字母、数字、空格和连字符。派生 key 时转为小写，连续空白转为一个连字符；结果必须以字母开头、符合安全 slug 格式、不超过 64 个字符，且不是 Windows 保留设备名。appId 必须符合反向域名格式，不超过 100 个字符。非法输入直接报错，不静默删除字符。

## 派生值与独立开关

以下以当前配置为例；名称变化时按同一规则派生，不把示例名称或全开状态作为合法性的条件。

| 类别 | 开启时的结果 | 控制方式 |
| --- | --- | --- |
| 品牌文字 | Open-ZCode | 默认使用 `name` |
| 安装名称、系统入口归属、可执行及包名称 | 按 Open-ZCode、open-zcode 和 appId 派生 | `customizeIdentity` |
| 正式 / Preview / Dev appId | dev.openzcode.app / dev.openzcode.app.preview / dev.openzcode.app.dev | `customizeIdentity` |
| 外部协议 | open-zcode:// | `customizeIdentity` |
| 正式 / Preview / Dev Electron profile | open-zcode / open-zcode-preview / open-zcode-dev | `customizeIdentity` |
| 用户私有根 | `<HOME>/.open-zcode` | `isolateUserData` |
| 可迁移业务根 | `<dataBaseDir>/.open-zcode` | `isolateUserData` |
| 启动设置 | `<HOME>/.open-zcode/v2/setting.json` | `isolateUserData` |
| 内嵌 Agent 用户目录候选及默认资料 | `.open-zcode` 下的既有子结构 | `isolateUserData` |
| 项目私有根 | `<workspacePath>/.open-zcode` | `isolateProjectData` |
| 项目根配置 / 忽略文件 / 分享目录 | open-zcode.json / .open-zcodeignore / .open-zcode-share | `isolateProjectData` |
| 工作流临时回落 | `<tmp>/open-zcode-workflow-runs` | `isolateProjectData` |

每个隔离开关单独选择派生值或该类上游原规则，不能因填写名称而自动开启其他类别。关闭资料隔离意味着允许共享上游资料，不拒绝构建，也不宣称该类别已隔离。

保持既有正式/Preview/Dev 与服务环境的选择，以及业务资料和协议的共享关系。显示名称与已开启类别的命名空间绑定，修改名称后重新构建会改变这些位置，没有自动迁移。

## 所有者与接入

配置在开发和构建入口读取：`scripts/product-config.mjs` 使用 `packages/shared/src/product.ts` 的统一校验与派生规则。Desktop、Host、UI 和内嵌 Agent 消费同一配置；NSIS 由构建入口传值，不维护第二份人工配置。未注入的独立构建保留上游名称和命名空间；共用源码的固定通用文案允许同步变化。

用户资料复用 `packages/services/src/paths.ts` 等既有解析入口，保持 HOME、dataBaseDir、workspacePath 的区别，以及参数、环境变量、setter 和显式 storage/config/log 路径的优先级。保留 v2、cli、skills、commands、subagents、hooks、plugins、workflows 等内部结构；不重写真实 HOME，不扩大原有 v2-only 复制范围。

内嵌 Agent 保持随包、当前仓库及用户目录的原有程序来源顺序；用户隔离开启时，只将用户目录候选转到新根，不自动回落官方私有目录。

项目隔离同步覆盖发现、读写、删除、监听、相对 cwd、权限、清理和失败回落，提示使用实际生效路径。仅修改位置，不改变配置层级、Workspace Identity 或状态所有者。

## 最小改动原则

- 优先接入既有公共解析函数和领域常量；没有公共入口时，在路径构造、系统注册或链接生成/校验处接入。
- 单独核对绕过公共入口的启动设置、固定 HOME 资源、Agent 候选，以及项目发现、监听、权限和清理消费者，不能只改写入路径。
- 保留导出名、调用方式、代码风格和换行，不全盘替换字符串，不顺便格式化或重构。上游默认值尽量留在原位置，避免复制第二套定义。
- 保留内部包名、类/函数名、协议字段、Hook 来源 kind、数据库格式、兼容插件格式、通用 `.agents` / `AGENTS.md` 和显式旧配置。
- 不改用户或第三方内容、来源署名、普通 Git 身份及历史数据；不自动导入、合并或清理官方资料。

验收场景及验证边界见 [产品隔离验收](product-isolation-verification.md)。
