import { useMemo, useSyncExternalStore } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getSourceServerStatusRegistry } from "@/store/sourceServerStatusRegistry.js";
import type { AggregatedSourceStatus } from "@/lib/remoteConnectionPresentation.js";

const emptyStatuses: ReadonlyMap<string, AggregatedSourceStatus> = new Map();
const subscribeToNothing = () => () => undefined;
const getEmptyStatuses = () => emptyStatuses;

export function useSourceServerStatuses() {
  const management = useBaseWorkspaceServices().sourceServerManagementService;
  const registry = useMemo(
    () => (management ? getSourceServerStatusRegistry(management) : null),
    [management],
  );
  return useSyncExternalStore(
    registry?.subscribe ?? subscribeToNothing,
    registry?.getSnapshot ?? getEmptyStatuses,
    registry?.getSnapshot ?? getEmptyStatuses,
  );
}

const emptyInputs: ReadonlyMap<
  string,
  import("@/lib/remoteConnectionPresentation.js").RemoteConnectionPresentationInput
> = new Map();
const getEmptyInputs = () => emptyInputs;

/** 管理快照中全部设备的展示输入（按 sourceServerId）；Web / 手机没有管理服务时为空。 */
export function useRemoteDevicePresentationInputs() {
  const management = useBaseWorkspaceServices().sourceServerManagementService;
  const registry = useMemo(
    () => (management ? getSourceServerStatusRegistry(management) : null),
    [management],
  );
  return useSyncExternalStore(
    registry?.subscribe ?? subscribeToNothing,
    registry?.getInputs ?? getEmptyInputs,
    registry?.getInputs ?? getEmptyInputs,
  );
}

export function useRemoteDevicePresentationInput(sourceServerId?: string) {
  const inputs = useRemoteDevicePresentationInputs();
  return sourceServerId ? inputs.get(sourceServerId) : undefined;
}
