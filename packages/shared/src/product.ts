/** 桌面构建注入五项产品配置；独立 CLI / Web 未注入时保留上游默认。 */
export interface ProductConfig {
  name: string;
  appId: string;
  customizeIdentity: boolean;
  isolateUserData: boolean;
  isolateProjectData: boolean;
}

declare const __ZCODE_PRODUCT_CONFIG__: ProductConfig | undefined;

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
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key) || key.length > 64) {
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
