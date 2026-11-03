import type { Terminal } from "@xterm/xterm";

/** 手机 229 输入由原生 input 事件提交，避免与 xterm 的定时 textarea 读取竞争。 */
export function attachTerminalMobileInput(term: Terminal, isWindowsDesktop: boolean) {
  const root = term.element;
  const textarea = term.textarea;
  const mobile =
    /Android|iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isWindowsDesktop || !mobile || !root || !textarea)
    return { handleKeyEvent: () => true, dispose() {} };

  let ownsInput = false;
  let composition: "idle" | "active" | "committing" = "idle";
  const reset = () => {
    ownsInput = false;
  };
  const handleKeyEvent = (event: KeyboardEvent) => {
    // 有字符的 keypress 会由 xterm 发送；交还事务，避免随后换行 input 再发一次回车。
    if (event.type === "keypress" && (event.charCode || event.which)) reset();
    if (event.type !== "keydown") return true;
    ownsInput =
      event.keyCode === 229 &&
      !event.isComposing &&
      composition === "idle" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey;
    // 保留 xterm 的 keyDownSeen，供 compositionend 后的原 input 去重使用；
    // 仅阻止 229 启动定时读取。对应普通 input 在下方 capture 中独占提交。
    // 不 preventDefault，保留浏览器更新 textarea 的原生行为。
    return !ownsInput;
  };
  const submit = (event: Event, text: string) => {
    ownsInput = false;
    event.stopPropagation();
    textarea.value = "";
    // 复用 onData 的唯一写入链路，保活重挂后仍使用当前 PTY 连接。
    term.input(text, true);
  };
  const onInput = (event: Event) => {
    const input = event as InputEvent;
    if (event.target !== textarea || !ownsInput || composition !== "idle" || input.isComposing)
      return;
    if (input.inputType === "insertText" && input.data) submit(event, input.data);
    // 手机回车可能只有 229 + insertLineBreak；接管 229 后必须在这里补全回车语义。
    else if (input.inputType === "insertLineBreak") submit(event, "\r");
    else if (input.inputType === "deleteContentBackward") submit(event, "\x7f");
    else if (input.inputType === "deleteContentForward") submit(event, "\x1b[3~");
    else reset();
  };
  const onBeforeInput = (event: Event) => {
    const input = event as InputEvent;
    if (event.target !== textarea || !ownsInput || composition !== "idle" || input.isComposing)
      return;
    // 已提交文字不留在隐藏 textarea；空 textarea 的原生删除可能没有 input，
    // 因此在 beforeinput 消费删除，避免吞掉终端退格。
    if (input.inputType === "deleteContentBackward" || input.inputType === "deleteContentForward") {
      event.preventDefault();
      submit(event, input.inputType === "deleteContentBackward" ? "\x7f" : "\x1b[3~");
    }
  };
  const onCompositionStart = () => {
    composition = "active";
    reset();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    // xterm 在 compositionend 的下一轮读取 textarea。它发出 onData 前仍由
    // 原组合链路持有输入，避免紧接着的 229 字符清空尚未提交的中文。
    composition = event.data ? "committing" : "idle";
  };
  const compositionCommit = term.onData((data) => {
    // PTY 的状态查询也会经 onData 回答，不能把 ESC 控制响应当作中文提交。
    if (composition === "committing" && getPlainTerminalInputText(data)) composition = "idle";
  });
  root.addEventListener("beforeinput", onBeforeInput, true);
  root.addEventListener("input", onInput, true);
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);
  textarea.addEventListener("blur", reset);
  textarea.addEventListener("paste", reset);
  return {
    handleKeyEvent,
    dispose() {
      compositionCommit.dispose();
      root.removeEventListener("beforeinput", onBeforeInput, true);
      root.removeEventListener("input", onInput, true);
      textarea.removeEventListener("compositionstart", onCompositionStart);
      textarea.removeEventListener("compositionend", onCompositionEnd);
      textarea.removeEventListener("blur", reset);
      textarea.removeEventListener("paste", reset);
    },
  };
}

export interface PendingTerminalInputFallback {
  handled: boolean;
  text: string;
}

export interface TerminalInputFallbackKeydownCandidate {
  kind: "text" | "imeCommit";
  text: string | null;
  eventTimeStamp: number;
  recordedAt: number;
}

export interface TerminalInputFallbackHandledData {
  consumed: boolean;
  data: string;
  keydownEventTimeStamp: number;
  kind: "text" | "imeCommit" | "recentData";
  recordedAt: number;
}

export function createPendingTerminalInputFallback(text: string): PendingTerminalInputFallback {
  return {
    handled: false,
    text,
  };
}

function isPlainTerminalInputData(data: string): boolean {
  // 方向键等控制输入会产生 ESC 序列，例如 "\x1b[D"。
  // 这些序列里的普通字符不能参与 composed input 兜底匹配，否则可能把真实待补文本误判为已处理。
  return Array.from(data).every((char) => {
    const code = char.codePointAt(0);
    return code !== undefined && code >= 0x20 && code !== 0x7f;
  });
}

function getPlainTerminalInputText(data: string): string | null {
  if (data.includes("\u001b")) {
    return null;
  }

  let text = "";
  for (const char of Array.from(data)) {
    const code = char.codePointAt(0);
    if (code !== undefined && code >= 0x20 && code !== 0x7f) {
      text += char;
    }
  }

  return text.length > 0 ? text : null;
}

function getHandledFallbackData(params: {
  candidate: TerminalInputFallbackKeydownCandidate;
  data: string;
}): string | null {
  if (params.candidate.kind === "imeCommit") {
    // 搜狗等三方输入法用 Enter 提交候选词时，xterm 的 onData 可能把中文和
    // Enter 控制符合并在同一个 chunk（例如 "中文\r"）。把整个 chunk 判为非 plain 会让
    // 后续 textarea input 兜底又写一次中文；这里只在 IME 提交键路径提取可打印文本。
    return getPlainTerminalInputText(params.data);
  }

  if (!isPlainTerminalInputData(params.data) || params.candidate.text !== params.data) {
    return null;
  }

  return params.data;
}

export function createTerminalInputFallbackKeydownCandidate(params: {
  eventTimeStamp: number;
  key: string;
  now: number;
}): TerminalInputFallbackKeydownCandidate | null {
  if (params.key === "Enter" || params.key === "Process") {
    // 搜狗等三方中文输入法在 Windows 上常用 Enter/Process 提交候选词。
    // 此时 xterm 可能已经通过 onData 发出中文，随后 textarea input 又残留同一段组合文本；
    // 这里保留提交键时间戳，让后续 plain onData 能和同一拍 input 去重，避免再次兜底写入。
    return {
      eventTimeStamp: params.eventTimeStamp,
      kind: "imeCommit",
      recordedAt: params.now,
      text: null,
    };
  }

  if (params.key.length !== 1 || !isPlainTerminalInputData(params.key)) {
    return null;
  }

  return {
    eventTimeStamp: params.eventTimeStamp,
    kind: "text",
    recordedAt: params.now,
    text: params.key,
  };
}

export function markTerminalInputFallbackHandled(
  pending: readonly PendingTerminalInputFallback[],
  data: string,
): void {
  const handledText = isPlainTerminalInputData(data) ? data : getPlainTerminalInputText(data);
  if (!handledText) {
    return;
  }

  let remainingData = handledText;
  for (const item of pending) {
    if (item.handled || item.text.length === 0) {
      continue;
    }
    const index = remainingData.indexOf(item.text);
    if (index === -1) {
      continue;
    }
    item.handled = true;
    remainingData = remainingData.slice(0, index) + remainingData.slice(index + item.text.length);
  }
}

export function recordTerminalInputFallbackHandledData(params: {
  candidate: TerminalInputFallbackKeydownCandidate | null;
  data: string;
  history: readonly TerminalInputFallbackHandledData[];
  maxAgeMs: number;
  now: number;
}): {
  history: TerminalInputFallbackHandledData[];
  usedCandidate: boolean;
} {
  const retainedHistory = params.history.filter(
    (item) => params.now - item.recordedAt <= params.maxAgeMs,
  );
  const candidate = params.candidate;
  if (!candidate || params.now - candidate.recordedAt > params.maxAgeMs) {
    return {
      history: retainedHistory,
      usedCandidate: false,
    };
  }

  const data = getHandledFallbackData({ candidate, data: params.data });
  if (!data) {
    return {
      history: retainedHistory,
      usedCandidate: false,
    };
  }

  return {
    history: [
      ...retainedHistory,
      {
        consumed: false,
        data,
        keydownEventTimeStamp: candidate.eventTimeStamp,
        kind: candidate.kind,
        recordedAt: params.now,
      },
    ],
    usedCandidate: true,
  };
}

export function recordTerminalInputFallbackRecentData(params: {
  data: string;
  history: readonly TerminalInputFallbackHandledData[];
  maxAgeMs: number;
  now: number;
}): TerminalInputFallbackHandledData[] {
  // 搜狗输入法提交候选词时，xterm 可能先通过 onData 写入中文，随后才派发
  // textarea composed input；这条路径没有稳定 keydown candidate，只能用极短窗口的 recentData 去重。
  const retainedHistory = params.history.filter(
    (item) => params.now - item.recordedAt <= params.maxAgeMs,
  );
  const data = isPlainTerminalInputData(params.data)
    ? params.data
    : getPlainTerminalInputText(params.data);
  if (!data) {
    return retainedHistory;
  }

  return [
    ...retainedHistory,
    {
      consumed: false,
      data,
      keydownEventTimeStamp: params.now,
      kind: "recentData",
      recordedAt: params.now,
    },
  ];
}

export function consumeTerminalInputFallbackHandledData(params: {
  history: readonly TerminalInputFallbackHandledData[];
  inputEventTimeStamp: number;
  maxAgeMs: number;
  maxInputDelayMs: number;
  now: number;
  pending: PendingTerminalInputFallback;
}): void {
  const matched = params.history.find(
    (item) =>
      !item.consumed &&
      params.now - item.recordedAt <= params.maxAgeMs &&
      params.pending.text === item.data &&
      (item.kind === "recentData"
        ? params.now - item.recordedAt <= params.maxInputDelayMs
        : params.inputEventTimeStamp >= item.keydownEventTimeStamp &&
          params.inputEventTimeStamp - item.keydownEventTimeStamp <=
            (item.kind === "imeCommit" ? params.maxAgeMs : params.maxInputDelayMs)),
  );
  if (!matched) {
    return;
  }

  matched.consumed = true;
  params.pending.handled = true;
}

export function resolveTerminalInputFallbackAction(params: {
  pending: PendingTerminalInputFallback;
  textareaValue: string;
}): {
  shouldClearTextarea: boolean;
  shouldWrite: boolean;
} {
  const hasTextareaValue = params.textareaValue.length > 0;
  const shouldWrite = !params.pending.handled && hasTextareaValue;
  return {
    shouldClearTextarea: hasTextareaValue && (params.pending.handled || shouldWrite),
    shouldWrite,
  };
}
