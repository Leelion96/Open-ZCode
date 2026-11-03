/**
 * zcode-site-panel 标准用法示例：面板读一个站点、处理失败，以及改名工具的参数。
 */
import { RENAME_SITE_TOOL, SITES_URI, type RenameSiteInput, type SitesResult } from "./contract.ts";

export function exampleSiteUri(siteId: string): string {
  return `${SITES_URI}/${siteId}`;
}

/** 资源内容解析后要么是 zcode-server 的 data，要么是错误码 / 失败原因。 */
export function exampleDescribe(result: SitesResult<{ name: string }>): string {
  if ("data" in result) return result.data.name;
  return result.error.code !== undefined ? `code ${result.error.code}` : `${result.error.reason}`;
}

export function exampleRename(): { name: typeof RENAME_SITE_TOOL; arguments: RenameSiteInput } {
  return { name: RENAME_SITE_TOOL, arguments: { siteId: "1978123456789012480", name: "Birthday" } };
}
