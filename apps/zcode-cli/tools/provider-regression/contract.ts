export interface RegressionOptions {
  providersFile: string;
  listFile: string;
  outputDir?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** 测试注入传输；不改全局 fetch，生产默认沿现有 Adapter 网络路径。 */
  transport?: typeof globalThis.fetch;
  onProgress?: (message: string) => void;
}
export interface RegressionRow {
  providerId: string;
  modelId: string;
  caseId: string;
  reasoningLevel: string;
  repetition: number;
  status:
    | "pending"
    | "running"
    | "passed"
    | "failed"
    | "skipped"
    | "untested"
    | "cancelled"
    | "review";
  startedAt?: string | null;
  endedAt?: string | null;
  maxOutputTokens?: number;
  executionPath?: "session" | "websearch-handler" | "adapter-probe";
  requestCount?: number;
  detail: string;
  reasoningTokens: number | null;
  reasoningCharacters: number | null;
  firstTextMs: number | null;
  durationMs: number | null;
  finishReason: string | null;
  answer: string;
  requestParameters: Record<string, unknown>[];
  parameterCheck: "matched" | "mismatch" | "unobserved";
}
export interface RegressionReport {
  /** 缺省字段仅用于读取旧版报告；新运行始终写入版本与执行元数据。 */
  schemaVersion?: 1;
  runId?: string;
  status?: "running" | "completed" | "cancelled" | "error";
  updatedAt?: string;
  endedAt?: string | null;
  execution?: {
    concurrency: { providers: number; models: number; cases: number };
    targets: {
      providerId: string;
      modelIds: string[];
      concurrency: { models: number; cases: number };
    }[];
  };
  startedAt: string;
  configHash: string;
  listHash: string;
  revision: number;
  dryRun: boolean;
  reasoningTask: { id: string; prompt: string; maxOutputTokens: number | null; timeoutMs: number };
  rows: RegressionRow[];
}
/** 显式配置驱动的一轮三级并行回归；始终保存脱敏快照，outputDir 指定每轮子目录的父目录。 */
export interface ProviderRegressionContract {
  run(options: RegressionOptions): Promise<RegressionReport>;
}
