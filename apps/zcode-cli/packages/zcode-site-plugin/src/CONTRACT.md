# zcode-site-panel

zcode-site 插件自带的 Sites 面板（UI plugin）：插件 MCP server（`server/`）把 zcode-server 的 `/api/v1/sites/*` 包装成面板可读的资源和两个写工具，面板页面（`ui/`）用官方 `@modelcontextprotocol/ext-apps` 渲染。规格见 [docs/site/sites-panel.md](../../../../../docs/site/sites-panel.md)。

不变量：

- 模型看不到：工具全部 `_meta.ui.visibility: ["app"]`，server 不返回 instructions。Agent 只经 Skill + CLI 操作站点。
- 读走资源，写走工具。资源 URI 以插件名开头、路径与 REST 一致，只放行契约里的读接口和查询参数；写只有改名和角标两个工具，经宿主现有审批链。
- 身份只取宿主附在每条消息 `_meta["com.zcode/official-mcp-auth"]` 上的头，不缓存、不落盘、不写日志；没有身份头时不发请求。401 不重试。
- 请求 origin 与宿主校验官方 MCP 目标时同一口径（`resolveRuntimeZCodeEndpointOrigin`）。
- 构建必定产出 `SITES_PANEL_OUTPUTS`，官方插件定义与三份打包清单都把它们列为必需资产；改产物路径时这几处一起改。产物自包含，运行时不读 `node_modules`。
