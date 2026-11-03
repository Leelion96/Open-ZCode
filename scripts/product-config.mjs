import { readFile } from "node:fs/promises";
import { parseProductConfig } from "../packages/shared/src/product.ts";

export async function loadProductConfig() {
  return parseProductConfig(
    JSON.parse(await readFile(new URL("../config/product.json", import.meta.url), "utf8")),
  );
}

export { productKey } from "../packages/shared/src/product.ts";

/** 只在构建时冻结更新授权；通用运行时环境不能改变正式包的发布来源。 */
export function resolveProductUpdateOrigin(env) {
  const scopedKey =
    env.ZCODE_ENV?.trim().toLowerCase() === "test"
      ? "ZCODE_TEST_BASE_URL"
      : "ZCODE_PRODUCTION_BASE_URL";
  const value = [env.ZCODE_BASE_URL, env.ZCODE_ENDPOINT_ORIGIN, env[scopedKey]]
    .find((item) => item?.trim())
    ?.trim();
  if (!value) return "";
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Update origin must not include credentials");
  // HTTP 开发服务仍可运行，但不能被固化为正式包的可信更新源。
  return url.protocol === "https:" ? url.origin : "";
}
