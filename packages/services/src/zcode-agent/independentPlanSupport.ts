import { zcodeProtocolMethods, zcodeRuntimeCapabilitiesSchema } from "@zcode/shared";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

const checks = new WeakMap<object, Promise<void>>();

/** Host 更新不代表远端 CLI 已更新；旧 CLI 会剥掉 Plan 字段，必须在发送前确认执行端。 */
export function ensureIndependentPlanSupport(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<void> {
  const cached = checks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => {
      if (result.independentPlanState !== true) throw new Error("proto.independentPlanUnsupported");
    })
    .catch((cause: unknown) => {
      checks.delete(client);
      throw new Error("proto.independentPlanUnsupported", { cause });
    });
  checks.set(client, check);
  return check;
}

const historyChecks = new WeakMap<object, Promise<boolean>>();
/** 远端旧 CLI 的 strict subscribe 不接受新字段，能力确认后才转发。 */
export function supportsHistoryFirst(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<boolean> {
  const existing = historyChecks.get(client);
  if (existing) return existing;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => result.historyFirst === true)
    .catch(() => {
      historyChecks.delete(client);
      return false;
    });
  historyChecks.set(client, check);
  return check;
}

const genUiChecks = new WeakMap<object, Promise<void>>();
/** 状态不能回退到拼接用户正文；不支持时保留草稿并拒绝发送。 */
export function ensureGenUiContextSupport(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<void> {
  const cached = genUiChecks.get(client);
  if (cached) return cached;
  const check = client
    .request(zcodeProtocolMethods.runtimeCapabilities, {}, zcodeRuntimeCapabilitiesSchema)
    .then((result) => {
      if (result.genUiContext !== true) throw new Error("proto.genUiContextUnsupported");
    })
    .catch((cause: unknown) => {
      genUiChecks.delete(client);
      throw new Error("proto.genUiContextUnsupported", { cause });
    });
  genUiChecks.set(client, check);
  return check;
}
