import type { WorkspaceMcpTrustContract } from "./contract.js";

export async function exampleWorkspaceMcpTrust(authority: WorkspaceMcpTrustContract) {
  const items = await authority.inspect();
  const first = Object.entries(items)[0];
  if (!first) return;
  // 真实调用必须来自用户对当前行的显式审核动作。
  await authority.decide(first[0], first[1].declarationDigest, true);
}
