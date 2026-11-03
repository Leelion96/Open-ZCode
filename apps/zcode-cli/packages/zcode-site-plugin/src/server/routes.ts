import { RESOURCE_SCHEME } from "../contract.ts";

const ID = /^[1-9][0-9]{0,19}$/;
const COUNT = /^[0-9]{1,9}$/;

/**
 * 数据资源 URI 到 REST 路径的映射。只放行契约里的读接口和它们的查询参数，
 * 页面传来的其他路径或参数一律拒绝，server 不替页面拼任意 zcode-server 路径。
 */
export function resourcePath(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== RESOURCE_SCHEME || url.username || url.password || url.port || url.hash)
    return undefined;
  const segments = [url.hostname, ...url.pathname.split("/").filter(Boolean)];
  const [root, siteId, deployments, deploymentId, logs] = segments;
  let path: string;
  let allowed: readonly string[];
  if (root === "usage" && segments.length === 1) {
    path = "/api/v1/sites/usage";
    allowed = [];
  } else if (root === "plans" && segments.length === 1) {
    path = "/api/v1/sites/plans";
    allowed = [];
  } else if (root !== "sites") {
    return undefined;
  } else if (segments.length === 1) {
    path = "/api/v1/sites";
    allowed = ["cursor", "limit"];
  } else if (!ID.test(siteId)) {
    return undefined;
  } else if (segments.length === 2) {
    path = `/api/v1/sites/${siteId}`;
    allowed = [];
  } else if (deployments === "cover" && segments.length === 3) {
    path = `/api/v1/sites/${siteId}/cover`;
    allowed = [];
  } else if (deployments !== "deployments") {
    return undefined;
  } else if (segments.length === 3) {
    path = `/api/v1/sites/${siteId}/deployments`;
    allowed = ["cursor", "limit"];
  } else if (!ID.test(deploymentId)) {
    return undefined;
  } else if (segments.length === 4) {
    path = `/api/v1/sites/${siteId}/deployments/${deploymentId}`;
    allowed = [];
  } else if (logs === "logs" && segments.length === 5) {
    path = `/api/v1/sites/${siteId}/deployments/${deploymentId}/logs`;
    allowed = ["offset"];
  } else {
    return undefined;
  }

  const query = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name) || query.has(name)) return undefined;
    // 空值等于没传：页面首页请求写成 `?cursor=` 也可以。
    if (value === "") continue;
    if (name !== "cursor" && !COUNT.test(value)) return undefined;
    query.set(name, value);
  }
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}
