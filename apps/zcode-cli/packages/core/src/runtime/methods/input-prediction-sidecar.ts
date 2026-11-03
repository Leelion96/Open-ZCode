// 输入预测 sidecar（手机远控 ghost hint）：按会话近期上下文 + 可选草稿生成候选，
// 供 v4 只读查询 v4/conversation/inputPrediction 使用。规格见
// docs/web-remote-control/mobile-input-prediction.md。
//
// 本文件只放提示词、纯函数和一个编排壳；模型执行面由调用方注入
// （bootstrap 经 app.generateWorkspaceText，querySource=input_prediction），单测不依赖 runtime。
import {
  INPUT_PREDICTION_MAX_CANDIDATES,
  INPUT_PREDICTION_MAX_TEXT_CHARS,
} from "@zcode/shared/zcode-protocol-v4";

export const INPUT_PREDICTION_QUERY_SOURCE = "input_prediction";

/** CLI 侧单次模型调用上限。ghost hint 迟到就没有价值，所以比通用辅助生成的 60s 短。 */
export const INPUT_PREDICTION_MODEL_TIMEOUT_MS = 20_000;
/** 上下文组装：最近 6 轮（用户输入全文 + 助手最终回复截断 800 字）。 */
export const INPUT_PREDICTION_CONTEXT_TURNS = 6;
export const INPUT_PREDICTION_ASSISTANT_MAX_CHARS = 800;
/** 上下文总预算（字符），超出时从最旧处截断。 */
export const INPUT_PREDICTION_CONTEXT_MAX_CHARS = 6_000;
/** 决策门槛：top 候选 confidence ≥ 0.80 才展示（宁缺毋滥）。 */
export const INPUT_PREDICTION_CONFIDENCE_THRESHOLD = 0.8;
/** 草稿为空时预测「下一条输入」，至少要有 2 轮真实用户输入。 */
export const INPUT_PREDICTION_NEXT_INPUT_MIN_TURNS = 2;
/** 草稿非空时预测续写，至少要有 1 轮真实用户输入。 */
export const INPUT_PREDICTION_DRAFT_MIN_TURNS = 1;
/** 去重时只看最近 2 条真实用户输入：用户刚发过的不再预测。 */
const RECENT_USER_INPUT_DEDUPE_COUNT = 2;

export interface InputPredictionTurnContext {
  /** 真实用户输入全文。 */
  userText: string;
  /** 本轮助手最终回复；没有回复为 null。 */
  assistantText: string | null;
}

export interface InputPredictionCandidate {
  text: string;
  confidence: number;
}

export interface InputPredictionOutcome {
  decision: "show" | "suppress_below_threshold" | "suppress_no_context";
  candidates: InputPredictionCandidate[];
  topConfidence: number;
}

export type InputPredictionModelMessage = { role: "system" | "user"; content: string };

export type InputPredictionModelCall = (
  messages: InputPredictionModelMessage[],
  options: { abortSignal: AbortSignal; querySource: string },
) => Promise<{ text: string }>;

const OUTPUT_FORMAT_RULE = `- 只输出一个 JSON 对象，不要 markdown 代码块，不要任何多余文字：
{"candidates":[{"text":"...","confidence":0.0},{"text":"...","confidence":0.0},{"text":"...","confidence":0.0}]}`;

const CONFIDENCE_RULE = `- 每个候选带 confidence（0 到 1 的小数）：你对"用户真的会这样写"的把握。三个候选的置信度要拉开差距；校准比乐观重要，拿不准就给低分。`;

// 草稿为空：预测下一条完整输入。
const NEXT_INPUT_SYSTEM_PROMPT = `你是输入预测器。根据下面的多轮对话上下文，预测这位用户下一条可能发送的输入。

这是预测任务，不是对话。绝不要回答、执行或延续对话内容；只输出预测结果。

规则：
- 恰好生成 3 个候选，按把握从高到低排列。
- 每个候选是一句用户自己会说的话（追问、指令、确认等语气），单行，不超过 ${INPUT_PREDICTION_MAX_TEXT_CHARS} 个字，语言与用户一致，不要像助手的回复。
${CONFIDENCE_RULE}
${OUTPUT_FORMAT_RULE}`;

// 草稿非空：预测草稿后面要接上的部分。
const DRAFT_SYSTEM_PROMPT = `你是输入补全器。根据下面的多轮对话上下文和用户正在输入的草稿，预测用户接下来要在草稿后面接着写的内容。

这是补全任务，不是对话。绝不要回答、执行或延续对话内容；只输出补全结果。

规则：
- 恰好生成 3 个候选，按把握从高到低排列。
- text 只写接在草稿末尾之后的新内容，不要重复草稿本身；单行，不超过 ${INPUT_PREDICTION_MAX_TEXT_CHARS} 个字，语言与草稿一致。
- 如果草稿末尾是半个词，text 从这个词剩下的部分开始写。
${CONFIDENCE_RULE}
${OUTPUT_FORMAT_RULE}`;

/** 草稿归一：纯空白视为无草稿。 */
export function normalizeInputPredictionDraft(draft: string | undefined): string {
  return draft && draft.trim().length > 0 ? draft : "";
}

/** 当前模式需要的最少真实用户输入轮数。 */
export function inputPredictionMinTurns(draft: string): number {
  return draft.length > 0 ? INPUT_PREDICTION_DRAFT_MIN_TURNS : INPUT_PREDICTION_NEXT_INPUT_MIN_TURNS;
}

/** 组装上下文：最近 N 轮，用户全文 + 助手截断，总预算从最旧处截断。 */
export function buildInputPredictionContext(
  turns: readonly InputPredictionTurnContext[],
  options?: { maxTurns?: number; assistantMaxChars?: number; totalMaxChars?: number },
): string {
  const maxTurns = options?.maxTurns ?? INPUT_PREDICTION_CONTEXT_TURNS;
  const assistantMaxChars = options?.assistantMaxChars ?? INPUT_PREDICTION_ASSISTANT_MAX_CHARS;
  const totalMaxChars = options?.totalMaxChars ?? INPUT_PREDICTION_CONTEXT_MAX_CHARS;
  const blocks = turns.slice(-maxTurns).map((turn) => {
    const assistant = turn.assistantText ?? "";
    const bounded =
      assistant.length > assistantMaxChars ? `${assistant.slice(0, assistantMaxChars)}…` : assistant;
    return `用户：${turn.userText}\n助手：${bounded || "（无回复）"}`;
  });
  const text = blocks.join("\n\n");
  // 保留最新上下文：超预算时丢最旧的部分。
  return text.length > totalMaxChars ? text.slice(text.length - totalMaxChars) : text;
}

/** 模型输入：system 提示词 + user 上下文（草稿模式附上草稿）。 */
export function buildInputPredictionMessages(
  turns: readonly InputPredictionTurnContext[],
  draft: string,
): InputPredictionModelMessage[] {
  const context = buildInputPredictionContext(turns);
  if (draft.length === 0) {
    return [
      { role: "system", content: NEXT_INPUT_SYSTEM_PROMPT },
      { role: "user", content: context },
    ];
  }
  return [
    { role: "system", content: DRAFT_SYSTEM_PROMPT },
    { role: "user", content: `${context}\n\n【用户正在输入的草稿】\n${draft}` },
  ];
}

/** JSON 清洗容错：剥 think 段、code fence、尾逗号、前后说明文字。 */
export function parseInputPredictionResponse(raw: string): InputPredictionCandidate[] | null {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const parsed = tryParseCandidates(withoutThinking) ?? tryParseCandidates(stripJsonArtifacts(withoutThinking));
  if (!parsed) return null;
  const cleaned = parsed.filter(
    (candidate) => candidate.text.length > 0 && Number.isFinite(candidate.confidence),
  );
  return cleaned.length > 0 ? cleaned : null;
}

function tryParseCandidates(text: string): InputPredictionCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return null;
  const result: InputPredictionCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const { text, confidence } = candidate as { text?: unknown; confidence?: unknown };
    if (typeof text === "string" && typeof confidence === "number") {
      result.push({ text, confidence });
    }
  }
  return result;
}

function stripJsonArtifacts(text: string): string {
  const fenced = text.match(/^```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i);
  let candidate = (fenced?.[1] ?? text).trim().replace(/,\s*([}\]])/g, "$1");
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first >= 0 && last > first) candidate = candidate.slice(first, last + 1);
  return candidate;
}

/**
 * 把模型给的候选收敛成「接在草稿后面的文本」：
 * - 单行化；
 * - 模型重复了草稿时剥掉草稿前缀；
 * - 无草稿时两端 trim，有草稿时只 trim 末尾（续写开头的空格有意义），
 *   但草稿以空白结尾时续写不再以空白开头；
 * - 截断到上限：线格式按 UTF-16 长度计（zod .max），截断时不劈开代理对。
 */
export function toInputPredictionSuffix(rawText: string, draft: string): string {
  let text = rawText.replace(/[\r\n]+/g, " ");
  if (draft.length === 0) {
    text = text.trim();
  } else {
    const trimmedDraft = draft.trimEnd();
    if (text.startsWith(draft)) text = text.slice(draft.length);
    else if (trimmedDraft.length > 0 && text.startsWith(trimmedDraft)) {
      text = text.slice(trimmedDraft.length);
    }
    text = text.trimEnd();
    if (/\s$/.test(draft)) text = text.trimStart();
  }
  if (text.length <= INPUT_PREDICTION_MAX_TEXT_CHARS) return text;
  let bounded = "";
  for (const codePoint of text) {
    if (bounded.length + codePoint.length > INPUT_PREDICTION_MAX_TEXT_CHARS) break;
    bounded += codePoint;
  }
  return bounded.trimEnd();
}

/**
 * 后过滤 + 决策：
 * - 轮数不够 → suppress_no_context；
 * - 收敛为续写文本，空白丢弃；
 * - 与最近 2 条真实用户输入相同（按完整文本，大小写/空白不敏感）丢弃；
 * - 候选间同文本只留置信度高者；
 * - 按置信度降序取前 3；top ≥ 门槛 → show，否则 suppress_below_threshold。
 */
export function decideInputPrediction(input: {
  rawCandidates: readonly InputPredictionCandidate[];
  draft: string;
  recentUserInputs: readonly string[];
  turnCount: number;
  threshold?: number;
}): InputPredictionOutcome {
  const { draft } = input;
  if (input.turnCount < inputPredictionMinTurns(draft)) {
    return { decision: "suppress_no_context", candidates: [], topConfidence: 0 };
  }
  const threshold = input.threshold ?? INPUT_PREDICTION_CONFIDENCE_THRESHOLD;
  const recent = new Set(
    input.recentUserInputs.slice(-RECENT_USER_INPUT_DEDUPE_COUNT).map(normalizeForDedupe),
  );
  const byKey = new Map<string, InputPredictionCandidate>();
  for (const candidate of input.rawCandidates) {
    const confidence = Math.min(1, Math.max(0, candidate.confidence));
    const text = toInputPredictionSuffix(candidate.text, draft);
    if (text.trim().length === 0) continue;
    const key = normalizeForDedupe(draft + text);
    if (recent.has(key)) continue;
    const existing = byKey.get(key);
    if (!existing || existing.confidence < confidence) byKey.set(key, { text, confidence });
  }
  const candidates = Array.from(byKey.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, INPUT_PREDICTION_MAX_CANDIDATES);
  const topConfidence = candidates[0]?.confidence ?? 0;
  return {
    decision:
      candidates.length > 0 && topConfidence >= threshold ? "show" : "suppress_below_threshold",
    candidates,
    topConfidence,
  };
}

/** 去重归一：小写 + 去掉全部空白。 */
function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/**
 * 编排壳：一次辅助模型调用。超时与外部取消合并成一个 signal；
 * 即使模型执行面没有及时响应 signal，也在 signal 触发时立即放弃等待。
 * 失败向上抛，由调用方决定降级（这里不吞错）。
 */
export async function generateInputPredictionCandidates(input: {
  turns: readonly InputPredictionTurnContext[];
  draft: string;
  callModel: InputPredictionModelCall;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}): Promise<InputPredictionCandidate[] | null> {
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? INPUT_PREDICTION_MODEL_TIMEOUT_MS);
  const abortSignal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, timeoutSignal])
    : timeoutSignal;
  const result = await raceAbort(
    input.callModel(buildInputPredictionMessages(input.turns, input.draft), {
      abortSignal,
      querySource: INPUT_PREDICTION_QUERY_SOURCE,
    }),
    abortSignal,
  );
  return parseInputPredictionResponse(result.text);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
