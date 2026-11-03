// 草稿换代首发失败（"草稿会话已切换，请重新发送"，产品竞态另外排期）的测试侧重发开关。
// 只对紧随其后的一次 sendV4Prompt 生效。
// 修复原因：开关原来放在 v4-conversation 的模块变量里，arm 之后本 case 没有发送时会泄漏到
// 同一 worker 的下一个 case；wdio beforeTest 在每个 case 开始时调用 reset 清除。
let armed = false;

/** 由重启准备 helper 调用；只对紧随其后的一次 sendV4Prompt 生效。 */
export function armDraftRegenerationResendOnce(): void {
  armed = true;
}

/** sendV4Prompt 读取并清除开关。 */
export function consumeDraftRegenerationResend(): boolean {
  const value = armed;
  armed = false;
  return value;
}

/** 每个 case 开始时清除，arm 过但没有发送的开关不留给下一个 case。 */
export function resetDraftRegenerationResend(): void {
  armed = false;
}
