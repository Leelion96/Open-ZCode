# Kimi K3.1 Pro：入口与配置合同

Status: implemented / pending-key-validation

## 范围

2026-10-26 核验。合并最新 staging 后，在原供应商扩展分支的 revision 35 上新增下列 8 条成员，正式/测试同步为 revision 36，全部默认启用。保留全部旧成员、启停、顺序、端点、能力与共享规则；新成员放在各模板启用组开头，不切换已有会话。新增只使用精确 templateId/modelId 覆盖，不扩大 K3 家族正则。

| 模板             | 新增模型 ID                            | 现有协议 |
| ---------------- | -------------------------------------- | -------- |
| moonshot-kimi    | kimi-k3.1-pro、kimi-k3.1-pro-highspeed | Messages |
| kimi-code-cn     | k3.1-pro、k3.1-pro-highspeed           | Chat     |
| kimi-code-intl   | k3.1-pro、k3.1-pro-highspeed           | Chat     |
| openrouter       | moonshotai/kimi-k3.1-pro               | Messages |
| opencode-go-chat | kimi-k3.1-pro                          | Chat     |

普通 API 与 Coding Plan 使用不同模型 ID 和凭据。OpenRouter、Go 没有独立 Highspeed ID，不复制原厂目录；Zen、SiliconFlow、百炼套餐的公开目录尚未列出，不添加猜测成员。无需新增 Provider 模板、Adapter、认证或 SDK 改动。

后续 revision 37 仅按[供应商展示顺序](./configuration.md#供应商展示顺序)调整模板块的位置；本页 revision 36 的模型新增合同及模板内成员顺序保持不变。

## 参数和证据边界

- 原厂与 Kimi Code 支持 low/high/max，强制思考，不提供 none/disabled。普通 API Messages 复用现有 output_config.effort 映射，输出字段 max_tokens；Kimi Code Chat 使用 reasoning_effort 与 max_tokens。Messages 的响应仍是已有 thinking/text/tool_use 和 signature 合同。
- Kimi Code 官方“不传 effort”默认 high，普通 API Chat 官方默认 max。ZCode 主动选择新模型时按现有合同选择档位列表最后一项（最高档 max），并显式发送；这不等于沿用供应商省略参数的默认值。本次不增加默认档位字段、不重排档位、不修改选择逻辑。
- OpenRouter 目录列出 low/high/max/none、默认 max，但原厂禁止关闭思考。首批明确提供双方一致的 low/high/max，不把目录的 none 直接作为该 Messages 路径已验证能力；关闭思考待该入口的明确协议/真实请求证据再讨论。采用既有 Messages effort 映射。
- Go 官方目录与接口表已列 kimi-k3.1-pro，Chat 路径可复用；首批沿既有 Go K3 的 max 档请求合同，仅发送 reasoning_effort=max，不从原厂推断聚合入口全部档位。其他档位待 Go 独立证据。继续使用原模板地址，不迁移已有端点。
- 八条窗口均为 1,048,576。Kimi Code 的实际窗口和 Highspeed 权限依赖套餐。OpenRouter 输出上限采用本入口目录的 943,718；其余保留 131,072 请求预算，属保守配置预算，不能把普通 API Chat 最大 1,048,576 复制到 Messages、Coding Plan 或 Go。
- 八条均声明文本/图像/视频输入和工具调用，音频/PDF/原生搜索不声明；OpenRouter 按目录声明结构化输出，其余入口暂不从 Chat 能力推断。模型支持媒体不代表客户端新增了媒体上传功能。
- 缺真实 Key 不阻止新增和启用；不宣称验证过流式、多轮工具、权限、额度或容量边界。

## 官方依据

- [Kimi 普通 API 目录](https://platform.kimi.com/docs/models)：两个普通 API ID。
- [K3.1 Pro 快速开始](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart)、[推理强度](https://platform.kimi.com/docs/guide/use-reasoning-effort)、[Messages](https://platform.kimi.com/docs/api/messages)：原厂参数、响应与请求字段；Messages 页面已有 K3.1 Pro 调用样例。
- [Kimi Code 型号与套餐](https://www.kimi.com/code/docs/en/kimi-code/models.html)：两个地区、两款新型号、权限、窗口和档位；官方默认从先前资料的 max 更新为 high。
- [OpenRouter 目录](https://openrouter.ai/api/v1/models)、[型号页](https://openrouter.ai/moonshotai/kimi-k3.1-pro)：精确 ID、容量、媒体和可选参数；none 与原厂差异保留待核验。
- [Go 目录](https://opencode.ai/zen/go/v1/models)、[Go 官方协议表](https://opencode.ai/v2/docs/console/go/)：新型号使用 Chat；[Zen 目录](https://opencode.ai/zen/v1/models)尚未列出。

## 验收与保留边界

两环境分别验证：精确成员/启用、最终能力、每个可选档位的实际请求补丁、无关闭思考档、旧配置语义与顺序不变、个人覆盖优先、模板规则不污染同名自定义入口。维护既有成员清单测试时只明确增加这八个身份；旧冻结摘要继续保留，另冻结 revision 35 配置以防放宽新增过滤掩盖已有变化。

真实 Key 验证需分别覆盖普通/套餐与国内/国际权限，流式响应、至少两轮工具循环和思考历史回传、媒体、请求预算与套餐上限。原厂文档建议换新模型时创建新会话；本轮不开发会话迁移、自动改选或线上下发。

## 本轮验证状态

在合入 staging `90c8ee76c6` 后，供应商配置相关 33 个测试文件、382 项测试通过，其中本规格新增 20 项；类型检查、lint（191 条现有 warning、0 error）、架构门禁、正式/测试配置同步检查、库存/摘要/本目录链接检查通过。新增场景先确认旧配置失败，再验证新增配置通过。

以任务起点 `dd10b6e7bf` 执行受影响单测，选中 1,922 个测试文件，报告 1,909 通过、9 失败、3 跳过，并有一个 worker 内存耗尽错误；测试报告为 21,117 通过、7 失败、48 跳过。未执行或改成全量根单测。失败情况如下：

| 检查                                                                   | 结果与边界                                                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `desktopE2EContainerScript.test.ts`                                    | Docker 文档表格格式与精确断言不一致，复跑仍失败。                                                                       |
| `e2eRuntimePaths.test.ts`                                              | 六个 E2E 源码含被禁止的系统临时路径，复跑仍失败。                                                                       |
| `r3RemoteSpecInventory.test.ts`                                        | 队列缺少 damaged-release 用例，复跑仍失败。                                                                             |
| `reactStableReferences.test.ts`                                        | `SettingsScopeDevice.tsx` 内联 Context 对象，复跑仍失败。                                                               |
| `e2eDesktopBuildCache.test.ts`                                         | 开发专用变量 `ZCODE_REACT_SCAN` 被全文件扫描命中，检查与变量清单未协调，复跑仍失败。                                    |
| `remoteFrontendOssPublish.test.ts`                                     | CI 已增加 desktop-preview include，测试精确清单未跟进，复跑仍失败。                                                     |
| `projectPrimaryRootUnresponsive.test.ts`                               | 批量运行失败，单独复跑通过。                                                                                            |
| `storagePreparationProtocol.test.ts`、`dev-cua-plugin-runtime.test.ts` | 缺 CLI 的 adapters/contracts 构建依赖；尝试冻结安装 CLI 依赖时，已有锁文件缺少 `@withfig/autocomplete@2.692.3` 而失败。 |

上述失败对应的测试、源码及输入文件均与 staging `90c8ee76c6` 一致，本轮未修改；未改锁文件，未扩大到无关功能修复。在最新纯 staging `e06710b7bd` 独立工作区复跑上述九个测试文件，六项断言仍失败、两项 CLI 依赖仍无法加载，目录探测通过；结果为 186 项通过、6 项失败、2 个文件加载失败。该证据确认失败不依赖本分支的供应商改动，维护者已反馈相关负责人。

2026-10-26 明确：这些与本次无关的基线失败不阻止配置提交/MR。保留失败事实，继续按[验证范围与提交判断](./validation.md)交付；不宣称全仓检查全绿。分支继续合入 `e06710b7bd`，推送受影响单测以该集成基线为准；真实 Key 验证仍待人工配合。

合入最新 staging `e06710b7bd` 后复验：供应商相关 33 个文件、382 项测试通过；类型检查、lint（191 warning、0 error）、数据库 schema 兼容检查（8 项及两库实际 schema）、架构测试（36 项）与架构门禁通过。正式/测试配置同步与文档清单检查通过。
