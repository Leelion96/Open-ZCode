import { useEffect } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useMcpStore } from "@/store/mcpStore.js";

export function useEnsureWorkspaceMcpLoaded(
  workspaceAbsPath: string,
  workspaceIdentity: string | undefined,
  rpcReady: boolean,
) {
  const services = useServices();

  // 修复说明：这里曾把当前 tab 的 mcpSyncService 设为 store 的全局目录服务，设置页 Scope
  // 选中其他设备时写入仍落到当前 tab 所在设备。现在目录服务随目标一起经
  // ensureLoadedForWorkspace 绑定，不再有全局服务。
  useEffect(() => {
    if (!rpcReady) {
      // remote tab 恢复时 App 会先拿到断连代理；若立即
      // 读取 MCP 目录，只是在 store 内吞掉了断连错误，并未遵守 workspace
      // RPC 隔离边界。等待真实 services 注册后再执行，不缓存也不跨 transport 重放。
      return;
    }
    void useMcpStore
      .getState()
      .ensureLoadedForWorkspace(workspaceAbsPath, services.mcpSyncService, workspaceIdentity);
  }, [rpcReady, services.mcpSyncService, workspaceAbsPath, workspaceIdentity]);
}
