// 直接读取内部队列会让开源 WDIO 配置加载失败；清单由原队列生成，目标判定保持一致。
import remoteTargetSpecs from "./e2e-remote-target-specs.json" with { type: "json" };

export const SSH_FORMAL_SPEC_GLOB =
  "./test/e2e/conversation-session/conversation-session-ssh-remote*.test.ts";
// Bug 根因：逐领域枚举漏掉新增候选目录，导致单进程全量与分片正式集合不一致。
export const MANUAL_REVIEW_SPEC_GLOB = "./test/e2e/**/manual-review/**/*.test.ts";

const REQUIRED_SSH_E2E_ENV = [
  "ZCODE_E2E_SSH_HOST",
  "ZCODE_E2E_SSH_USERNAME",
  "ZCODE_E2E_SSH_PASSWORD",
];

export function hasRequiredSshE2EEnvironment(env) {
  return REQUIRED_SSH_E2E_ENV.every((name) => env[name]?.trim());
}

export function isSshFormalSpec(spec) {
  const normalized = spec.replaceAll("\\", "/");
  return (
    normalized.includes("/conversation-session/conversation-session-ssh-remote") ||
    remoteTargetSpecs.some((candidate) => normalized.endsWith(`/test/e2e/${candidate}`))
  );
}

export function resolveEnvironmentGatedFormalSpecExcludes({ env, targeted }) {
  // 修复原因：SSH P0 依赖真实服务器，默认全量在无凭据时纳入只会把环境缺失
  // 误记为三个产品失败；显式定向运行仍保留 helper 的缺变量 fail-closed 提示。
  return !targeted && !hasRequiredSshE2EEnvironment(env)
    ? [SSH_FORMAL_SPEC_GLOB, ...remoteTargetSpecs.map((spec) => `./test/e2e/${spec}`)]
    : [];
}

/** 目录 glob 是批量回归；只有逐个指定文件才覆盖环境门禁并按缺配置报错。 */
export function isExplicitE2ESpecSelection(specs) {
  return specs.length > 0 && specs.every((spec) => !/[*?[{]/u.test(spec));
}
