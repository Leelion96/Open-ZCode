import {
  modelDescriptorOf,
  type ModelRequestSessionType,
  type ModelRetryBudget,
} from "@zcode/contracts";
import {
  CoreErrorType,
  createCoreError,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Model,
  type ModelInvocationContext,
  type ModelRequest,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelFactoryInput } from "../types.js";
import {
  resolveModelRequestSessionTypeFromTaskType,
  resolveModelRetryBudgetFromTaskType,
} from "./model-request-session-type.js";
import { getOffPeakModelBinding } from "../off-peak/model-binding.js";
import { readSessionFeatures } from "../session-features/contract.js";

export function createRuntimeModel(
  runtime: AgentRuntimeInternal,
  input: Omit<RuntimeModelFactoryInput, "selection"> & {
    selection: RuntimeModelFactoryInput["selection"] | undefined;
    scope?: "session" | "workspace";
    /**
     * 覆盖按 taskType 解析的重试预算，只绑定到本次创建的句柄，不进入 Factory 输入。
     * 目前只有带 selectionFallback 声明的执行作用域 Selection 使用 single-attempt。
     */
    retryBudget?: ModelRetryBudget;
  },
): Model {
  const { retryBudget, scope = "session", ...factoryInput } = input;
  // 未绑定 Session 可恢复历史；仅在执行入口拒绝缺失选择，Factory 契约仍严格。
  if (!factoryInput.selection) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Select a model before continuing", {
      recoverable: true,
    });
  }
  const model = withRuntimeInvocationLayer(
    runtime,
    runtime.modelFactory({ ...factoryInput, selection: factoryInput.selection }),
    scope === "workspace"
      ? "other"
      : resolveModelRequestSessionTypeFromTaskType(runtime.config.taskType),
    retryBudget,
    // 工作区独立请求会借用同一工作区里某个会话的 runtime，不能带上那个会话的能力标签。
    scope !== "workspace",
  );
  return getOffPeakModelBinding(input.requestDependencies)?.wrap(model) ?? model;
}

/**
 * runtime 层调用上下文。
 *
 * 准入端口与重试预算回答的是「谁在调」（这个 runtime 归哪个治理器管、允许多少次重试），不是
 * 「为什么调」（agent step / web_search / compact / title）。设计缺口：它们若只在 turn step
 * 的调用上下文里注入，WebSearch / WebFetch 处理 / 压缩 / 标题 sidecar 等九处只设「为什么调」的
 * 调用点全部绕过了闸门——实测场景下治理器看不见三分之二的 429。现在这两个字段在句柄
 * 工厂绑定一次；`withModelInvocationContext` 的合并顺序让本层压过调用层，没有逐调用退出口：
 * 想不受闸门约束的 runtime 本来就不带准入端口。
 */
function withRuntimeInvocationLayer(
  runtime: AgentRuntimeInternal,
  model: Model,
  sessionType: ModelRequestSessionType,
  retryBudget: ModelRetryBudget | undefined,
  includeSessionFeatures: boolean,
): Model {
  const layer: ModelInvocationContext = {
    // 原因：标题、Memory、工具调用曾按用途覆写 other，丢失宿主分类。
    // 会话类型统一绑定在句柄上；工作区独立请求即使借用会话 runtime 也保持 other。
    modelRequestSessionType: sessionType,
    // 带退回声明的执行句柄显式传入 single-attempt，其余沿用 taskType 默认预算。
    modelRetryBudget: retryBudget ?? resolveModelRetryBudgetFromTaskType(runtime.config.taskType),
    ...(runtime.modelRequestAdmission === undefined
      ? {}
      : { modelRequestAdmission: runtime.modelRequestAdmission }),
  };
  // 会话能力标签在会话中途增加，而 turn model、subagent 复用的父句柄都会长期持有，所以每次调用
  // 时读取 owner 的当前集合，不在创建句柄时存快照。显式写 undefined：不让调用层带进别的值。
  return withOutermostRuntimeLayer(model, () => {
    const features = includeSessionFeatures ? readSessionFeatures(runtime) : [];
    return {
      ...layer,
      modelRequestSessionFeatures: features.length === 0 ? undefined : features,
    };
  });
}

/**
 * 本次调用链上是否已有一层 runtime 层生效（外层 = 真正发起调用的 runtime）。
 *
 * 修复原因：subagent 继承父模型时直接复用父 runtime 交出的句柄（`createInheritedSubagentModelFactory`），
 * 句柄上已绑着父的 runtime 层。子 runtime 再包一层后，按「本层压过调用层」的合并顺序，靠近 adapter
 * 的父层会盖掉子层——子 runtime 的准入端口、重试预算与会话类型全部失效：subagent 的请求拿着父的
 * observer（不排队、不看 Retry-After），会话类型也被标成 main。runtime 层之间因此改为**外层优先**：
 * 外层已生效时内层原样透传；runtime 层压过调用层这一条不变。
 *
 * 标记放在调用上下文本身里（模块私有 Symbol 键），而不是另一个 AsyncLocalStorage：内层可能被
 * **延后**调用——off-peak 包装的 streamText 是 async generator，要到第一次 next()、await 换票之后
 * 才调用内层。只有调用上下文会经 `runWithModelInvocationContext` 的迭代器包装跨过 next() 边界；
 * 单独的 ALS 在那一刻已经为空，父层会重新盖掉子层（MR !3127 评审 CR-01）。其余包装层都以
 * `{ ...current, ...own }` 合并上下文，对象展开会带上 Symbol 键，标记因此一路传到内层。
 */
const RUNTIME_LAYER_APPLIED: unique symbol = Symbol("runtimeLayerApplied");

type MarkedInvocationContext = ModelInvocationContext & { [RUNTIME_LAYER_APPLIED]?: true };

function withOutermostRuntimeLayer(
  model: Model,
  resolveLayer: () => ModelInvocationContext,
): Model {
  const call = <T>(run: () => T): T => {
    const current = getCurrentModelInvocationContext() as MarkedInvocationContext | undefined;
    if (current?.[RUNTIME_LAYER_APPLIED] === true) return run();
    const marked: MarkedInvocationContext = {
      ...current,
      ...resolveLayer(),
      [RUNTIME_LAYER_APPLIED]: true,
    };
    return runWithModelInvocationContext(marked, run);
  };
  const wrapped: Model = {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    requestCapabilities: model.requestCapabilities,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      return withOutermostRuntimeLayer(model.bind(options), resolveLayer);
    },
    generateText(request) {
      return call(() => model.generateText(request));
    },
    streamText(request) {
      return call(() => model.streamText(request));
    },
  };
  return Object.freeze(wrapped);
}

export function withModelInvocationContext(
  model: Model,
  createContext: (request: ModelRequest) => ModelInvocationContext,
): Model {
  const wrapped: Model = {
    ...modelDescriptorOf(model),
    bind(options) {
      return withModelInvocationContext(model.bind(options), createContext);
    },
    generateText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.generateText(request),
      );
    },
    streamText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.streamText(request),
      );
    },
  };
  return Object.freeze(wrapped);
}
