/**
 * zcode-site 插件面板（UI plugin）的对外契约：插件 MCP server 提供的资源、工具与结果形状，
 * 以及构建保证产出的文件。面板页面与 server 只经这里约定的 URI 和形状交互，规格见
 * docs/site/sites-panel.md。
 */

/** `.zcode-plugin/plugin.json` 里 mcpServers 的 key，也是 ui.surfaces[].server。 */
export const SITES_SERVER_NAME = "sites";
export const SITES_SURFACE_ID = "sites";
export const PANEL_URI = "ui://zcode-site/panel.html";
export const PANEL_MIME = "text/html;profile=mcp-app";

/** 数据资源的 URI 以插件名开头，路径与 REST 一致：`zcode-site://sites/{siteId}` ↔ `GET /api/v1/sites/{siteId}`。 */
export const RESOURCE_SCHEME = "zcode-site:";
export const RESOURCE_MIME = "application/json";
export const USAGE_URI = "zcode-site://usage";
export const PLANS_URI = "zcode-site://plans";
export const SITES_URI = "zcode-site://sites";
export const COMMANDS_URI = "zcode-site://commands";

export const RENAME_SITE_TOOL = "rename_site";
export const SET_SITE_BADGE_TOOL = "set_site_badge";

/** 构建后在插件根目录下必定存在的产物；官方插件定义与三份打包清单都把它们列为必需资产。 */
export const SITES_PANEL_OUTPUTS = ["dist/server.mjs", "dist/ui/panel.html"] as const;

/**
 * 请求没有拿到 zcode-server 业务响应的原因：
 * - `official_auth_*` / `official_mcp_origin_untrusted`：宿主没有给出身份头，原样转交；
 * - `unauthenticated`：zcode-server 返回 401（未登录或 JWT 失效），不重试；
 * - `network`：连不上或超时；`bad_response`：响应不是 `{code, data}` 信封。
 */
export const SITES_FAILURE_REASONS = [
  "official_auth_unavailable",
  "official_auth_plan_required",
  "official_mcp_origin_untrusted",
  "unauthenticated",
  "network",
  "bad_response",
] as const;
export type SitesFailureReason = (typeof SITES_FAILURE_REASONS)[number];

/** `code` 是 zcode-server 的错误码（Sites 业务码 36xx 等），与 `reason` 二选一。 */
export interface SitesError {
  code?: number;
  reason?: SitesFailureReason;
  /** zcode-server 响应的 logid，只用于排障展示。 */
  logid?: string;
}

/** 资源内容与工具 structuredContent 的形状：成功时 `data` 原样取自 zcode-server 响应。 */
export type SitesResult<T = unknown> = { data: T } | { error: SitesError };

/** `zcode-site://commands` 的一项，取自插件 `commands/*.md` 的文件名与 frontmatter。 */
export interface SiteCommand {
  /** 斜杠命令名，不带 `/`，如 `site-deploy`。 */
  name: string;
  description: string;
  argumentHint?: string;
}

export interface RenameSiteInput {
  siteId: string;
  name: string;
}

export interface SetSiteBadgeInput {
  siteId: string;
  hidden: boolean;
}
