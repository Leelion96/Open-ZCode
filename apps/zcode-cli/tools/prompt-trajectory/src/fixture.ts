import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface RuntimeModelTargetConfig {
  apiKey?: string;
  apiKeyRequired?: boolean;
  baseURL?: string;
  headers?: Record<string, string>;
  kind?: string;
  model: string;
  name?: string;
  provider: string;
  providerOptions?: Record<string, unknown>;
}

export interface RuntimeModelConfig {
  available?: RuntimeModelTargetConfig[];
  lite?: RuntimeModelTargetConfig;
  main: RuntimeModelTargetConfig;
}

export interface PromptTrajectoryFixture {
  modelInputFormat?: Partial<{
    supportsText: boolean;
    supportsImage: boolean;
    supportsVideo: boolean;
    supportsAudio: boolean;
    supportsPdf: boolean;
  }>;
  /** 覆盖录制用 Registry 模型的能力声明，例如打开 supportsNativeWebSearch 以暴露 WebSearch。 */
  modelProperties?: Partial<{
    supportsMidConversationSystem: boolean;
    supportsNativeWebSearch: boolean;
  }>;
  model?: {
    apiKey?: string;
    apiKeyEnv?: string;
    apiKeyRequired?: boolean;
    headers?: Record<string, string>;
    id?: string;
    kind?: string;
    model?: string;
    provider?: string;
    upstreamBaseURL?: string;
  };
  mockResponses?: unknown[];
  name: string;
  runtimeConfig?: Record<string, unknown>;
  steps: PromptTrajectoryStep[];
  workspaceFiles?: Record<string, string>;
}

export type PromptTrajectoryStep =
  | {
      attachments?: PromptTrajectoryAttachment[];
      text: string;
      type: "submitPrompt";
    }
  | {
      count?: number;
      eventType: string;
      timeoutMs?: number;
      type: "waitForEvent";
    };

export interface PromptTrajectoryAttachment {
  content?: string;
  path?: string;
  type: "file" | "image" | "pdf" | "url";
}

export async function loadFixture(path: string): Promise<PromptTrajectoryFixture> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as PromptTrajectoryFixture;
}

export async function createFixtureWorkspace(fixture: PromptTrajectoryFixture): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "zcode-prompt-trajectory-"));
  for (const [relativePath, content] of Object.entries(fixture.workspaceFiles ?? {})) {
    const target = join(workspace, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return workspace;
}

export function createRuntimeModelConfig(input: {
  fixture: PromptTrajectoryFixture;
  proxyBaseURL: string;
  env: NodeJS.ProcessEnv;
}): RuntimeModelConfig {
  const model = input.fixture.model;
  if (!model) throw new Error("Model config is missing. Provide fixture model.");

  const target = resolveModelTarget(input.fixture);
  const apiKey = model.apiKey ?? readApiKey(model, input.env);
  return {
    main: {
      apiKey,
      apiKeyRequired: model.apiKeyRequired ?? Boolean(model.apiKeyEnv || model.apiKey),
      baseURL: input.proxyBaseURL,
      headers: model.headers,
      kind: model.kind ?? "openai-compatible",
      model: target.model,
      provider: target.provider,
    },
  };
}

// 运行时配置只接受结构化的 Model Selection；「provider/model」字符串解析已从 contracts 移除。
export function resolveModelSelection(fixture: PromptTrajectoryFixture): {
  modelId: string;
  providerId: string;
} {
  const target = resolveModelTarget(fixture);
  return { modelId: target.model, providerId: target.provider };
}

export function resolveUpstreamBaseURL(input: { fixture: PromptTrajectoryFixture }): string {
  const explicit = input.fixture.model?.upstreamBaseURL;
  if (explicit) return explicit;
  throw new Error("Fixture model is missing upstreamBaseURL for prompt trajectory recording.");
}

function resolveModelTarget(fixture: PromptTrajectoryFixture): {
  model: string;
  provider: string;
} {
  if (fixture.model?.provider && fixture.model.model) {
    return {
      model: fixture.model.model,
      provider: fixture.model.provider,
    };
  }

  const id = fixture.model?.id;
  if (id) {
    const slashIndex = id.indexOf("/");
    if (slashIndex < 0) {
      throw new Error("Fixture model id must be formatted as provider/model.");
    }
    return {
      model: id.slice(slashIndex + 1),
      provider: id.slice(0, slashIndex),
    };
  }

  throw new Error("Model config is missing. Provide fixture model.");
}

function readApiKey(
  model: NonNullable<PromptTrajectoryFixture["model"]>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const key = model.apiKeyEnv;
  if (!key) return undefined;
  const value = env[key];
  if (!value) {
    throw new Error(`Missing API key env ${key}.`);
  }
  return value;
}
