/** 设备列表“最近使用”排序输入（RDUX-13）。 */
export interface SourceServerDeviceRecency {
  sourceServerId: string;
  online: boolean;
  /** 最近在线与最近打开项目中较新的时间；未知为 0。 */
  lastUsedAt: number;
}

/** 在线设备在前，其余按最近使用倒序；时间相同保持快照顺序。 */
export function rankSourceServerDevicesByRecentUse(
  devices: readonly SourceServerDeviceRecency[],
): string[] {
  return devices
    .map((device, index) => ({ device, index }))
    .sort(
      (left, right) =>
        Number(right.device.online) - Number(left.device.online) ||
        right.device.lastUsedAt - left.device.lastUsedAt ||
        left.index - right.index,
    )
    .map(({ device }) => device.sourceServerId);
}

/**
 * 冻结排序：首次就绪时排一次；之后状态变化不移动位置，快照中新出现的设备插到顶部，
 * 已移除的设备直接删除。没有变化时返回原数组引用，供渲染期派生状态判断是否需要更新。
 */
export function reconcileSourceServerDeviceOrder(
  previous: readonly string[] | null,
  devices: readonly SourceServerDeviceRecency[],
): readonly string[] {
  if (!previous) return rankSourceServerDevicesByRecentUse(devices);
  const known = new Set(previous);
  const present = new Set(devices.map((device) => device.sourceServerId));
  const added = devices
    .map((device) => device.sourceServerId)
    .filter((sourceServerId) => !known.has(sourceServerId));
  const kept = previous.filter((sourceServerId) => present.has(sourceServerId));
  if (added.length === 0 && kept.length === previous.length) return previous;
  return [...added, ...kept];
}

/** 搜索词去掉首尾空白后，不区分大小写地包含匹配任一字段；空搜索词匹配全部。 */
export function matchesSourceServerDeviceSearch(
  query: string,
  fields: readonly (string | undefined)[],
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return fields.some((field) => field?.toLocaleLowerCase().includes(needle));
}
