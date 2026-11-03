# 2026-10-15：主流模型默认推荐与供应商、套餐扩展

Status: implemented / pending-key-validation

本页记录 revision 35 的实施历史。2026-10-26 的 revision 38 已新增 MiniMax 正式版并调整旧型号；Preview 仅保留兼容且默认关闭，正式版容量与退役处理以[M3.1 Flash 规格](./minimax-m31-flash.md)为准，不沿用本页历史候选限制。

## revision 35 实施合同

用户已确认执行上一版列出的 32 条新增成员启用、19 条旧主线默认关闭；保留全部旧成员和规则，不删除型号。为维持已启用成员在前的现有合同，仅对受影响模板做稳定分组，组内维持原顺序。个人显式启停覆盖继续优先；不迁移已保存的模型选择。热门、免费、最新是积极启用理由，缺真实 Key 单列待实测，不作为默认关闭条件。

新增 11 个模板、26 条默认启用成员，均使用现有静态 Key 和三种 API 合同，不新增执行适配：

| 模板 ID                 | 产品和协议                     | 首批成员                                                                              |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| volcengine-ark          | 方舟普通 API / Messages        | doubao-seed-2-1-pro-260915、doubao-seed-2-1-lite-260915、doubao-seed-2-1-turbo-260628 |
| volcengine-coding-plan  | 方舟 Coding Plan / Messages    | doubao-seed-2.1-pro、doubao-seed-2.1-lite                                             |
| volcengine-agent-plan   | 方舟 Agent Plan / Messages     | doubao-seed-2.1-pro、doubao-seed-2.1-lite                                             |
| stepfun                 | 阶跃普通 API / Messages        | step-5-preview、step-3.7-flash                                                        |
| stepfun-step-plan       | Step Plan / Messages           | step-5-preview、step-3.7-flash                                                        |
| siliconflow-cn          | SiliconFlow 国内 / Chat        | zai-org/GLM-5.3、deepseek-ai/DeepSeek-V4-Flash、moonshotai/Kimi-K2.7-Code             |
| qwen-coding-plan-cn     | 百炼 Coding Plan / Chat        | qwen3.7-plus                                                                          |
| qwen-token-plan-team-cn | 百炼 Token Plan 团队版 / Chat  | qwen3.8-max、qwen3.8-flash                                                            |
| kimi-code-cn            | Kimi Code 国内 / Chat          | k3、k3-256k、kimi-for-coding、kimi-for-coding-highspeed                               |
| kimi-code-intl          | Kimi Code 国际 / Chat          | 同上，地区凭据分别验证                                                                |
| minimax-m-plan-cn       | MiniMax M Plan 国内 / Messages | MiniMax-M3.1-Flash-Preview                                                            |

普通 API、Coding Plan、Agent Plan、Token Plan 和 M Plan 是独立产品身份；不能复用同品牌普通 API 的 Key，也不能从同品牌推断套餐目录。Step Plan 按官方合同复用平台 Key，但采用独立套餐路径。百炼 Token Plan 团队版使用官方公开北京地址，其他地区/个人套餐不由此推断。

方舟选择 Messages：现有执行链已支持 thinking 块和 signature 回传；不接需要额外 encrypted_content 回传的 Chat 路径。Seed 暴露 none/low/medium/high，none 关闭思考，其余使用 output_config.effort；普通 API 为 1,024,000/256,000，Turbo 窗口 256,000。Coding Plan 输出预算按官方接入样例先限 65,536，Agent Plan 按其样例限 256,000。Step 两型号使用 low/medium/high，Step 5 窗口 1,000,000、输出 64,000；Step 3.7 窗口 262,144，输出暂用 128,000 配置基线，非已验证最大值。

SiliconFlow 使用自身 enable_thinking 合同；GLM/Kimi 先保留单一 enabled 档，避免套用原厂未确认的 effort；DeepSeek Flash 暴露 disabled/high/max。GLM 窗口 1,048,576、输出 128,000；DeepSeek 为 1,048,576/393,216；Kimi 为 262,144/98,304。除 DeepSeek 公开目录上限外，输出预算沿已维护型号基线，待该入口实测。百炼 Coding Plan 首批 qwen3.7-plus 使用 enable_thinking 开关和 65,536 输出预算；Token Plan 两型号沿官方 qwen3.8 effort 合同 low/medium/xhigh。

Kimi Code 的 k3、k3-256k、kimi-for-coding 使用 low/high/max；HighSpeed 仅 enabled。k3 和 kimi-for-coding 按官方目录 1,048,576（k3-256k 和 HighSpeed 为 262,144）；k3 的 1M 能力需更高套餐权限，低档账户使用 k3-256k。输出预算分别先用 131,072 和 HighSpeed 98,304 的已维护型号基线，未宣称套餐最大输出已验证。MiniMax M3.1 强制 adaptive 与五档 effort，不暴露 disabled；窗口 1,000,000，输出先保留 M3 系列 32,000 的保守配置预算，待套餐实测。媒体只声明该接口支持的格式；不因模型支持视频而宣称现有客户端可上传视频。

验收需覆盖：两环境精确成员/端点/档位、最终请求字段、个人覆盖、新规则不泄漏到其他模板、原有配置除已批准启停和稳定分组外不变。新增三个供应商 Logo 使用官方本地素材，沿用现有双主题渲染。正式配置单源生成测试配置；无真实 Key 时不能把这些离线检查称为真实 Agent 验证。

## revision 34 新增模型范围（revision 35 已启用）

在既有三种 API 协议内补充 28 个模板成员，并增加 TokenHub 国内、国际两个普通 API 模板，各含 Hy3、Hy4 Preview。revision 34 实施时新增成员全部默认关闭；不改变旧成员、默认启停、排序、URL、Access 或共享规则，不开发额外适配。正式 JSON 是唯一编辑源，测试 JSON 由现有脚本生成，revision 同步递增。

新成员的能力和参数差异写在 `templateModelRules` 的精确身份上。本轮先隔离新增影响，不扩大共享正则，不更改没有模板身份的个人模型推断。模板层允许精确覆盖；后续若要将这些事实提升到共享 Model/API 层，需先讨论其对其他入口和个人模型的影响。个人显式覆盖仍拥有最后优先级。

## 新增清单

| 模板                          | 新增成员                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openai                        | gpt-6.1-sol、gpt-6-luna                                                                                                                                                                                     |
| anthropic                     | claude-opus-5-5、claude-sonnet-5-5、claude-haiku-5-5                                                                                                                                                        |
| xai                           | grok-4.7                                                                                                                                                                                                    |
| zai-standard-api              | glm-5.3-flashx                                                                                                                                                                                              |
| openrouter                    | openai/gpt-6.1-sol、openai/gpt-6-luna、anthropic/claude-opus-5.5、anthropic/claude-sonnet-5.5、anthropic/claude-haiku-5.5、x-ai/grok-4.7、z-ai/glm-5.3-flashx、xiaomi/mimo-v2.6-pro、xiaomi/mimo-v2.6-flash |
| opencode-zen-responses        | gpt-6.1-sol、gpt-6-luna、grok-4.7                                                                                                                                                                           |
| opencode-zen-messages         | claude-opus-5-5、claude-sonnet-5-5、claude-haiku-5-5                                                                                                                                                        |
| opencode-zen-chat             | mimo-v2.6-flash-free                                                                                                                                                                                        |
| opencode-go-responses         | gpt-6-luna、grok-4.7                                                                                                                                                                                        |
| opencode-go-messages          | claude-haiku-5-5                                                                                                                                                                                            |
| opencode-go-chat              | mimo-v2.6-pro、mimo-v2.6-flash                                                                                                                                                                              |
| tencent-tokenhub-cn（新增）   | hy3、hy4-preview                                                                                                                                                                                            |
| tencent-tokenhub-intl（新增） | hy3、hy4-preview                                                                                                                                                                                            |

TokenHub 两个模板使用静态 API Key、Chat Completions，地址分别为 `https://tokenhub.tencentmaas.com/v1`、`https://tokenhub-intl.tencentmaas.com/v1`。国内外账号与区域权限分别验证。Messages 虽有通用兼容说明，本轮取得的 Hy3/Hy4 逐型号档位证据主要来自 Chat 调用指南，因此先使用证据更完整的 Chat 路径，不把通用 Messages 参数表推导为全部档位均可用。模板名称提供中英文，使用本地打包的腾讯云官方 GitHub 组织图标，并在素材清单记录来源；复用既有深浅主题渲染方式。

## 能力与参数要求

- GPT-6.1 Sol 使用 low/medium/high/xhigh/max；GPT-6 Luna 另有 none。Responses 使用 `reasoning.effort`；OpenRouter Messages 使用 `output_config.effort`，none 显式关闭思考，不能给 Sol 提供关闭档。窗口 1,050,000，输出 128,000，图像/PDF 与结构化输出按入口声明。
- Claude 5.5 三项优先暴露五档 adaptive，避免把 Sonnet 的 between_tools 当成关闭思考，也不引入 Haiku 关闭思考与高档位的非法组合。窗口 1,000,000、输出 128,000，复用已有 Messages 执行链。
- Grok 4.7 为 500,000 窗口、图像输入、low/medium/high/xhigh。原厂和 OpenCode 未取得独立最大输出合同，暂保留 128,000 配置基线并列为待验证，不能宣称这是官方最大值；OpenRouter 的上限按其目录为 450,000，PDF 也仅按该聚合入口声明。
- GLM FlashX 原厂不加入 Coding Plan。原厂 Chat 显式发送 `thinking.type=enabled` 与 `reasoning_effort`，输出使用 `max_tokens`；不发送通用 Chat 的其他兼容字段。OpenRouter 使用 Messages effort 映射，容量和媒体按该入口目录单独覆盖。
- MiMo V2.6 原厂与聚合容量不能混用。OpenRouter 采用目录所列实际路由窗口 1,048,576、输出 131,072；OpenCode 先沿原厂 1,000,000/131,072 的能力基线，需实测路由上限。Chat 使用 thinking 开关及 `max_completion_tokens`，Messages 使用 thinking 开关及 `max_tokens`；不宣称支持原生搜索。
- TokenHub Hy3 为 256,000/128,000，Hy4 Preview 为 1,024,000/64,000，纯文本。Agent 工具场景先暴露 none/high：官方说明 Hy3 携带 tools 时 low 会映射到 high，避免出现两个实际等价档位。仅发送 `reasoning_effort` 和 `max_tokens`，结构化 Schema 输出暂不声明为已支持。

## 本轮证据

检查日期均为 2026-10-15；仅公开资料与匿名目录 GET，没有推理请求或付费调用。

- OpenAI：[Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)。
- Anthropic：[模型目录](https://platform.claude.com/docs/en/models/overview)、[effort 与思考组合](https://platform.claude.com/docs/en/build-with-claude/effort)。
- xAI：[Grok 4.7](https://docs.x.ai/developers/models/grok-4.7)、[思考协议](https://docs.x.ai/developers/model-capabilities/text/reasoning)。
- Z.AI：[Flash/FlashX](https://docs.z.ai/guides/vlm/glm-5.3-flash)。
- MiMo：[Chat 接口](https://mimo.mi.com/docs/en-US/api/chat)、[Messages 接口](https://mimo.mi.com/docs/zh-CN/api/chat/anthropic-api)。两协议的输出字段分别为 `max_completion_tokens` 和 `max_tokens`，不能混写；聚合 Chat 保留该协议基线，待 Key 验证实际转发。
- OpenRouter：[公开目录](https://openrouter.ai/api/v1/models)。本次 462 项，按精确 ID 核对容量、模态、参数与档位。
- OpenCode：[协议分配](https://opencode.ai/v2/docs/console/models/)、[Go](https://opencode.ai/v2/docs/console/go/)。本次 Zen 86 项、Go 37 项；新旧目录内容仍相同。当前代码已为旧 Go 地址发送稳定会话 Header，不需要新增适配；本轮不迁移旧端点。目录数量相对前一日改变，不自动删除已有配置。
- TokenHub：[地区及鉴权](https://cloud.tencent.com/document/product/1823/130078)、[型号容量](https://cloud.tencent.com/document/product/1823/130051)、[混元调用](https://cloud.tencent.com/document/product/1823/132252)、[开关及逐型号推理档位](https://cloud.tencent.com/document/product/1823/131208)、[Messages 通用合同](https://cloud.tencent.com/document/product/1823/135874)。

## 验收

先写测试并确认旧配置不能满足新增场景，再修改配置：

1. 两环境新增成员精确、默认启用、解码及最终能力完整；模板不携带 Key。
2. 每个公开思考档位编译并应用真实 Option Map，断言最终字段、输出预算及禁止字段；低输出预算也不能生成非法 thinking budget。
3. 新模板实例可被解析；个人地址、名称、模型启停和能力覆盖仍保留。
4. 去除本轮显式新增项，还原批准的 19 条默认关闭、允许受影响成员稳定分组后，配置与起点相同；对旧成员解析结果进行对账，防止误改宽规则、账号配置或默认基线。
5. 正式生成测试配置、派生检查、类型/Lint/架构及受影响测试；无 UI 交互、Adapter 或 CLI 源码变更，不将配置测试等同于桌面/远程 E2E 或真实 Agent 验收。

## 暂缓、待讨论与人工协作

- Google 原生、Mistral 需要响应/历史转换的路径、云凭据刷新等额外适配暂缓。
- 方舟、StepFun、SiliconFlow 和百炼/Kimi/MiniMax 套餐已落首批配置；其余套餐成员、国际入口及地区差异继续核验，不复制原厂目录。Azure/Bedrock 需要具体资源/部署/区域和模型权限，不能硬编码示例地址作为可用模板。
- MiniMax 退役、聚合目录缺项、其他已有启停与旧端点迁移仍按既有变更先讨论；本轮只修改明确确认的 51 条启停。
- 人工提供普通/套餐、地区、模型权限明确的受限 Key 与测试预算后，逐入口做流式、工具回传、每档思考和媒体验证。缺 Key 不阻止按维护原则默认启用或提交配置 MR，但不宣称已实测或已交付。

## revision 34 验证记录（历史结果）

- 先红后绿：新增配置专项在旧配置下 68 项失败、2 项基线对账通过；图标新增断言在未接线时两主题均失败。最终 8 个定向测试文件、171 项通过。Chat 输出字段另经过 6 个失败场景验证后修正为官方合同，旧聚合成员断言未改。
- 初次受影响测试：78 个文件、1536 项通过。同步上游后，按原始起点 `0d663379324a2fdc0afa91cb10aaee9a70fb462e` 计算的范围扩大至 1386 个文件，最终 1386 文件全部通过，15509 项通过、28 项为套件原有跳过项，无未处理错误；未运行全量单测。
- 使用 `mise exec --` 固定 Node 24.14.0。非固定版本 24.19.0 的远控重试测试失败，定向切回固定版本后通过；扩大检查的 worker 曾耗尽默认堆，最终命令增加 `NODE_OPTIONS=--max-old-space-size=6144`，未跳过测试。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`（0 violations）、`pnpm provider:config:check-test` 通过。
- 两环境全部 492 个旧模板成员的最终解析结果与起点逐项相同。旧字段、成员顺序、账号与共享规则的语义摘要也相同；两环境新增成员均默认关闭。
- 历史 Map 库存曾遗漏 revision 33 的 MiMo V2.6。准备提交时，最新 staging `0ec2bf27fe` 已修正该测试分类，本分支快进采用上游修正，不重复提交；该模型配置及历史请求等价断言未变。
- 图标本地资源与深浅主题解析测试通过；Linux Chromium 在 390/1200 宽度、深浅底色、中英文、16/20/32 像素检查图标，无裁切或背景依赖。检查使用独立素材预览，不算实际设置页或桌面/手机 E2E。
- 未验证：真实 Key、供应商流式与工具调用、推理多轮历史、媒体/结构化输出组合、容量边界、Windows/macOS 实机及发布/动态下发。音频能力值只记录上游模型声明，不代表客户端已交付音频输入链路。

## 影响面与配置所有权

本轮包括模型事实新增、已确认的默认推荐调整，以及本地图标资源新增。模板选择器从设置 View 读取模板，创建动作仍由 `useModelProviders` 调用 `ProviderSettingsFacade.createPersonalProvider`，写个人配置并产生自己的 Provider 身份。`ProviderConfigResolver` 负责模板继承和个人覆盖；模板自身不成为可执行 Provider。

| 入口或事实                         | 本轮关联                                                                 | 必须保留的边界                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 模板选择、供应商卡、侧栏与产品标题 | 共享 ProviderLogo 的资源 key 新增；名称来自模板中英文元数据              | 图标不参与身份、排序、认证或执行判断                                                  |
| 模板实例及个人模型                 | Resolver 合并新增模板/精确型号规则                                       | 用户显式地址、名称、启停、能力覆盖最后生效，账号配置不变                              |
| 对话、自动化、Subagent 模型候选    | 有效 Registry 提供默认启用模型；本轮增补最新主线并关闭指定旧主线默认推荐 | 各入口草稿、提交与持久化归属继续分开，不自动切换已有会话                              |
| 本地、远程和测试环境               | 消费同一配置合同；正式到测试仅由生成器转换环境地址                       | 不修改远端下发、会话生命周期或当前 Active Model；配置有音频声明不等于存在音频执行适配 |

语义图扫描命中 provider-templates、provider-registry、model-capabilities 及 provider-settings，沿一跳检查继承、创建、候选供应和隔离边界。当前会话无 codegraph 工具，直接调用核验用文本检索与源码完成；未声称完成调用图深度扫描。图谱关系未变，无需新增节点。图谱仍链接旧维护材料，建议后续单独收口入口；本规格不以这些材料作为前置上下文。diff 的辅助文件为素材来源、定向测试和功能性供应商词登记，均对应上述范围。

## revision 35 公开依据（2026-10-15）

- 方舟：[普通 API 型号与容量](https://docs.volcengine.com/docs/ark/model-list?lang=zh)、[Messages 协议](https://docs.volcengine.com/docs/ark/messages-api?lang=zh)、[逐型号参数](https://docs.volcengine.com/docs/ark/model-parameter-support?lang=zh)、[思考签名回传要求](https://docs.volcengine.com/docs/ark/go-live-faq?lang=zh)、[普通/套餐路径](https://docs.volcengine.com/docs/ark/integrate-third-party-tools?lang=zh)、[Coding Plan 接入](https://docs.volcengine.com/docs/ark/coding-plan-enterprise-ai-opencode?lang=zh)、[Agent Plan 接入](https://docs.volcengine.com/docs/ark/agent-plan-personal-zcode?lang=zh)。普通 API 日期 ID 与套餐点号 ID 不可混用；参数取各产品预算。
- StepFun：[Step 5](https://platform.stepfun.com/docs/zh/guides/models/step-5-preview)、[Step 3.7](https://platform.stepfun.com/docs/zh/guides/models/step-3.7-flash)、[Messages](https://platform.stepfun.com/docs/zh/api-reference/chat/messages-create)、[Step Plan](https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api)。本轮通过官方 Markdown 页面取得正文；Messages 仅声明明确支持的图片，视频能力不从 Chat 推导。
- SiliconFlow：[官方目录](https://siliconflow.cn/models)、[Chat 参数](https://docs.siliconflow.cn/docs/api/chat-completions-post)。目录 ID 保留大小写及前缀，不将原厂 thinking 字段直接转发；单一 enabled 档的细分 effort 留待该入口合同补充。
- 百炼：[Coding Plan 目录及独立 Key](https://help.aliyun.com/zh/model-studio/coding-plan)、[Token Plan 团队版目录](https://help.aliyun.com/zh/model-studio/token-plan-team-overview)、[团队版北京端点](https://help.aliyun.com/zh/model-studio/deepseek-harness)、[Chat 参数](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。Coding Plan 首批选本套餐较新的 qwen3.7-plus；Token Plan 单独支持 qwen3.8 主线。
- Kimi Code：[两地区端点和 Key](https://www.kimi.com/code/docs/en/)、[四个型号、容量、思考和套餐要求](https://www.kimi.com/code/docs/en/kimi-code/models.html)。不伪装 User-Agent；权限不足是套餐授权问题，不是模型已退役。
- MiniMax：[M Plan 订阅 Key 与调用](https://platform.minimax.cn/docs/m-plan/quickstart)、[M3.1 协议](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)、[产品限制及旧型号日期](https://platform.minimax.cn/docs/guides/models-intro)。新型号只加入独立 M Plan，不把 10 月 19 日开始改路由和 11 月 18 日正式停服混成已失效。

## revision 35 验证结果

- 测试先行：配置及图标专项在修改前 92 项失败、13 项通过；完成配置后 6 个文件 127 项通过，包含 19 条启停授权校验、稳定分组及用户手动启用旧型号/关闭新型号。
- 受影响测试以 `07af577320a6c6a6a8f7946c25beb1e30630ff50` 为起点选择 78/2643 个文件，1497 项通过；随后补充的 4 项个人覆盖/顺序断言也已定向通过。未运行全量单测。
- 直接读取 JSON 的历史测试不一定被增量选择：补跑 Provider Node 全目录及 Logo 测试，最终 34 个文件、370 项通过。期间修正 MiMo/Go 的旧默认启停与成员断言，并按既有规范展开新增嵌套 Map；旧成员的能力/请求合同继续保留，没有跳过失败项。
- Node 24.14.0 下类型、Lint、架构检查通过；Lint 有 210 条仓库警告、0 错误，架构 0 violations；正式/测试派生、格式、链接及最终 diff 另在提交前核对。
- Linux Chromium 的独立素材预览覆盖 390/1200 宽度、浅/深背景、中英文与 16/20/32 像素：三个新增官方 Logo 可辨识、无裁切；素材原有方形底色保留。不是实际设置页、桌面或手机 E2E。
- 未验证：各产品真实 Key/权益、计费推理、流式与两轮工具循环、容量和媒体边界、Windows/macOS 实机；未执行合并、发布或动态下发。
