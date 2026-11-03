# MiniMax M3.1 Flash 正式版与旧型号维护

2026-10-26 确认实施，正式与测试配置升至 revision 38。目标是让用户在已支持的入口选择正式版，同时区分停止新用户、已下线与兼容别名。只更新配置、测试与本目录文档，复用现有协议，不新增 Adapter，不自动迁移个人模型选择，也不执行在线发布。

## 官方证据与入口

- [模型发布](https://platform.minimax.cn/docs/release-notes/models)：2026-10-19 发布正式 `MiniMax-M3.1-Flash`，不再仅限套餐 Preview。
- [Messages API](https://platform.minimax.cn/docs/api-reference/text-chat-anthropic)：支持图像、视频、工具调用和 thinking；强制思考，禁止 disabled，`output_config.effort` 支持 low/medium/high/xhigh/max，默认 max；输出最大 524288，推荐 131072。[SDK 说明](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)列上下文 1000000。
- [M Plan](https://platform.minimax.cn/docs/m-plan/intro)：Preview 已退役，但旧名称请求由正式版服务。[订阅接入](https://platform.minimax.cn/docs/m-plan/quickstart)确认套餐 Key 与按量 Key 分离。
- [原厂生命周期](https://platform.minimax.cn/docs/faq/models)：M2.5/M2.7 在 10 月 19 日停止新用户、11 月 18 日停止存量按量调用，套餐旧名已转发正式版；同页历史表又称其已下线，存在冲突，不能据此提前删除。M2/M2.1/M2.1-highspeed 已列下线，未列存量宽限。
- [OpenRouter 模型目录](https://openrouter.ai/api/v1/models)及[端点目录](https://openrouter.ai/api/v1/models/minimax/minimax-m3.1-flash/endpoints)：存在 `minimax/minimax-m3.1-flash`；模型级上下文 1048576、输出 524288，支持图像、视频、工具与 reasoning。各路由容量不同，不把某一路由的更高输出上限推广到全部入口。
- [Go 文档](https://opencode.ai/docs/go/)列 `minimax-m3.1-flash` 使用 Chat；[既有 Go 目录](https://opencode.ai/zen/go/v1/models)也列出该 ID。[Zen 目录](https://opencode.ai/zen/v1/models)未列正式版，因此不向 Zen 猜测添加。文档已改用 inference URL，目录在旧路径仍可读，但不等于旧路径推理已实测；本轮不改变既有模板端点。

## 配置合同

| 模板              | 新增型号                   | 协议     | 上下文  | 输出上限/预算      | 思考档位                  |
| ----------------- | -------------------------- | -------- | ------- | ------------------ | ------------------------- |
| minimax           | MiniMax-M3.1-Flash         | Messages | 1000000 | 524288             | low/medium/high/xhigh/max |
| minimax-m-plan-cn | MiniMax-M3.1-Flash         | Messages | 1000000 | 524288             | low/medium/high/xhigh/max |
| openrouter        | minimax/minimax-m3.1-flash | Messages | 1048576 | 524288             | low/medium/high/xhigh/max |
| opencode-go-chat  | minimax-m3.1-flash         | Chat     | 1000000 | 131072（保守预算） | max                       |

四个新增成员全部默认启用，放在各模板成员开头；其余成员相对顺序不变。使用精确 templateId/modelId 规则覆盖 M3 宽规则，不改变共享家族规则。Messages 发送 `output_config.effort`；原厂两个入口另发送 `thinking.type=adaptive`，聚合入口沿其兼容协议传递 effort。Go 首批只暴露 max，以 Chat 的 `reasoning_effort` 传递，复用 `max_tokens`。Go 的五档、实际容量及旧路径推理仍待 Key 验证，不能把原厂全部合同当作 Go 实测结果。

新增模型均支持文本、图片、视频和工具调用；不声明音频、PDF 或原生搜索。OpenRouter 按目录声明结构化输出，其余入口暂不声明。原厂现有 base URL 保持不变；文档采用新域名不是替换用户端点的充分证据。

| 已有身份                                                   | 本轮变化                               | 原因与边界                                                   |
| ---------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| minimax / MiniMax-M2.7、MiniMax-M2.7-highspeed             | enabled true → false，保留成员         | 新用户已不能调用；存量宽限结束后再核验删除                   |
| minimax / MiniMax-M2、MiniMax-M2.1、MiniMax-M2.1-highspeed | 删除模板成员与对应精确规则             | 原厂明确下线；不删除共享规则，不影响个人手动配置和其他供应商 |
| minimax-m-plan-cn / MiniMax-M3.1-Flash-Preview             | enabled true → false，保留成员和原参数 | 旧名仍有转发能力，不是不可用身份；新增正式名供主动选择       |
| minimax / MiniMax-M2.5、MiniMax-M2.5-highspeed             | 保持默认关闭和成员                     | 与 M2.7 同属宽限，不提前删除                                 |
| 原厂 M3、OpenRouter/Go/Zen 的旧 MiniMax 成员               | 不变                                   | 原厂生命周期不能跨入口推导，聚合目录仍有旧型号               |

个人 enabled、容量等显式覆盖仍优先。默认关闭不会替用户改成新模型；保留别名也不代表继续作为默认推荐。新增、停用、删除清单与配置摘要一起审核。两环境使用同一正式源派生，模板品牌顺序继续遵守[排序规则](./configuration.md#供应商展示顺序)。

## 验证与交付

先写两环境的新增目录、每档请求、生命周期、个人覆盖和非目标配置保护测试，再修改配置。完整摘要以 revision 37 为基线，只豁免表中四个新增、三个删除、三个 enabled 变更；旧的阶段性全量摘要由这一最新边界接续，已有模型行为测试继续保留。不得通过更新整个新文件摘要掩盖无关变化。

本轮不增加 UI 交互，不新增桌面 E2E。配置检查不能证明真实账号权限、流式、工具历史或媒体可用；后续按[验证规范](./validation.md)使用各产品凭据做流式和两轮工具回传，并核验全部思考档、容量、旧端点和 Preview 别名。未取得 Key 不阻止符合证据的新增入库。

Git revision 38 不等于线上采用；动态交付使用独立新 URL 与 hash，不覆盖 36/37，分别核验测试和正式控制面。回滚用更高 revision 恢复旧配置并重新生成测试文件，不能降低 revision；恢复已下线成员不意味着上游重新可用。

2026-10-26 验证结果：

- 新增测试在旧配置上 14 项失败，修改后 14 项通过；配置、思考 Map、模板与历史行为相关 9 个文件共 225 项通过。
- `pnpm test:unit:affected --base a803b46643b4789bac2ad6b0129915e07d0dad0a`：官方选择的 6 个文件、145 项通过。
- `pnpm typecheck`、`pnpm lint`（191 条既有 warning、0 error）、`pnpm architecture:check --changed`（0 violation）、`pnpm provider:config:check-test` 通过；格式、文档链接、库存统计、两环境 hash 和开源功能词检查通过。
- 两环境均为 34 模板、313 成员、126 默认启用；只发生上述四新增、三删除、三启停，端点、品牌顺序、账号配置及共享规则未改变。
- 未进行真实 Key 推理、UI E2E 或在线发布；公开 Models 目录与离线参数映射不等于推理实测。
