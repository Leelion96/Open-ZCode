import type { IPlatformService } from "@zcode/shared";
import { initializeDesktopLocalTtft } from "./contract.js";

/** 平台通过依赖注入提供日志和原有遥测能力。 */
export function installLocalTtft(platform: IPlatformService): () => void {
  return initializeDesktopLocalTtft(platform);
}
