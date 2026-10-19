/** 控制端显示偏好不写远端 position；暂时不可见的入口保留原位置。 */
export function reconcileProjectOrder(
  saved: readonly string[],
  current: readonly string[],
): string[] {
  return [...new Set([...saved, ...current])];
}
export function moveProjectOrder(
  saved: readonly string[],
  section: readonly string[],
  active: string,
  over: string,
): string[] {
  const from = section.indexOf(active),
    to = section.indexOf(over);
  if (from < 0 || to < 0 || from === to) return [...saved];
  const moved = [...section];
  moved.splice(to, 0, moved.splice(from, 1)[0]!);
  const members = new Set(section);
  let index = 0;
  return reconcileProjectOrder(saved, section).map((key) =>
    members.has(key) ? moved[index++]! : key,
  );
}
