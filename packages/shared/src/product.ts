/** Desktop/Web 构建注入配置；HTTP Host 将同一配置传给原 Agent，独立 CLI 保留默认。 */
export interface ProductConfig {
  name: string;
  appId: string;
  customizeIdentity: boolean;
  isolateUserData: boolean;
  isolateProjectData: boolean;
}

declare const __ZCODE_PRODUCT_CONFIG__: ProductConfig | undefined;
/** 仅供应用 Host 向原 Agent 传递已校验的完整配置，不维护另一份人工配置。 */
export const PRODUCT_CONFIG_ENV_KEY = "ZCODE_PRODUCT_CONFIG_JSON";

export function parseProductConfig(value: unknown): Readonly<ProductConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("product.json must be an object");
  }
  const raw = value as Record<string, unknown>;
  const keys = ["name", "appId", "customizeIdentity", "isolateUserData", "isolateProjectData"];
  if (Object.keys(raw).some((key) => !keys.includes(key))) {
    throw new Error("product.json contains an unknown field");
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const appId = typeof raw.appId === "string" ? raw.appId.trim() : "";
  const key = name.toLowerCase().replace(/\s+/g, "-");
  // 名称还会直接进入安装器宏；只校验派生 key 会放过名称中的换行。
  if (!/^[A-Za-z0-9 -]+$/.test(name) || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key) || key.length > 64) {
    throw new Error("product.name must produce a safe ASCII name (for example Open-ZCode)");
  }
  if (!/^[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/.test(appId) || appId.length > 100) {
    throw new Error("product.appId must be a reverse-domain application ID");
  }
  for (const field of keys.slice(2)) {
    if (typeof raw[field] !== "boolean") throw new Error(`product.${field} must be a boolean`);
  }
  if (
    [
      "con",
      "prn",
      "aux",
      "nul",
      ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
      ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
    ].includes(key)
  ) {
    throw new Error("product.name is reserved on Windows");
  }
  return Object.freeze({
    name,
    appId,
    customizeIdentity: raw.customizeIdentity as boolean,
    isolateUserData: raw.isolateUserData as boolean,
    isolateProjectData: raw.isolateProjectData as boolean,
  });
}

export const PRODUCT_CONFIG: Readonly<ProductConfig> =
  typeof __ZCODE_PRODUCT_CONFIG__ !== "undefined"
    ? parseProductConfig(__ZCODE_PRODUCT_CONFIG__)
    // 普通 Agent 产物/源码回退原先未注入配置；沿原 spawn 环境接入，避免继续写上游目录。
    : typeof process !== "undefined" && process.env[PRODUCT_CONFIG_ENV_KEY]?.trim()
      ? parseProductConfig(JSON.parse(process.env[PRODUCT_CONFIG_ENV_KEY]!))
    : Object.freeze({
        name: "ZCode",
        appId: "dev.zcode.app",
        customizeIdentity: false,
        isolateUserData: false,
        isolateProjectData: false,
      });

export function productKey(config: Readonly<ProductConfig> = PRODUCT_CONFIG): string {
  return config.name.toLowerCase().replace(/\s+/g, "-");
}

export const PRODUCT_PROTOCOL_SCHEME = PRODUCT_CONFIG.customizeIdentity ? productKey() : "zcode";
export const PRODUCT_USER_DIRECTORY = PRODUCT_CONFIG.isolateUserData
  ? `.${productKey()}`
  : ".zcode";
export const PRODUCT_PROJECT_DIRECTORY = PRODUCT_CONFIG.isolateProjectData
  ? `.${productKey()}`
  : ".zcode";
export const PRODUCT_PROJECT_CONFIG_FILE = PRODUCT_CONFIG.isolateProjectData
  ? `${productKey()}.json`
  : "zcode.json";
export const PRODUCT_PROJECT_IGNORE_FILE = PRODUCT_CONFIG.isolateProjectData
  ? `.${productKey()}ignore`
  : ".zcodeignore";
export const PRODUCT_PROJECT_SHARE_DIRECTORY = PRODUCT_CONFIG.isolateProjectData
  ? `.${productKey()}-share`
  : ".zcode-share";
export const PRODUCT_WORKFLOW_TEMP_DIRECTORY = PRODUCT_CONFIG.isolateProjectData
  ? `${productKey()}-workflow-runs`
  : "zcode-workflow-runs";

export const PRODUCT_IDENTITY_KEY = PRODUCT_CONFIG.customizeIdentity ? productKey() : "zcode";

// 显示名称独立于安装身份和私有资料根。
export const PRODUCT_DISPLAY_NAME = PRODUCT_CONFIG.name;

export const PRODUCT_AGENT_DISPLAY_NAME = `${PRODUCT_DISPLAY_NAME} Agent`;
export const PRODUCT_PROCESS_PREFIX = PRODUCT_DISPLAY_NAME.toLowerCase().replace(/\s+/g, "-");
export const PRODUCT_DEFAULT_PROJECT_DIRECTORY = `${PRODUCT_DISPLAY_NAME}Project`;

/** 用于 Linux 系统入口的显示名称；完整单词匹配，保留协议、路径、代码标识和配置名称。 */
export function formatProductOwnedText(text: string): string {
  // 完整配置名称优先匹配，避免 Open ZCode 等名称在再次消费时被重复加前缀。
  const name = PRODUCT_DISPLAY_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${name}|(?<![\\w./-])Z ?[Cc]ode(?![\\w/-])`, "g"), PRODUCT_DISPLAY_NAME);
}
