import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { decodeExecutionOutputBuffer } from "./outputEncoding.js";
import type { OutputPersistenceMode } from "./execution-adapter-types.js";
import type { ExecutionStreamResult } from "@zcode/contracts";

export interface AggregatePersistedOutputBudget {
  bytes: number;
  maxBytes: number;
}

/**
 * 一路输出最后 maxBytes 字节的有界尾部（请求级 `outputLimit.tailBytes`）。
 *
 * 刻意不复用 `appendTail` 的进度尾部：那块 buffer 按适配器配置的 progressTailBytes 定尺寸
 * （默认很小），每个进度事件都整块解码一次，每个 chunk 都 `Buffer.concat` 一次——放大到
 * 请求级的 MiB 量级，就是每个 chunk 复制整个尾部（总输出 × 尾部大小）、每个进度 tick 解码
 * 整个尾部。这里按块存、整块出队，摊还 O(总输出)，只在结算时拼一次。
 */
class ByteTail {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    const kept =
      chunk.byteLength > this.maxBytes ? chunk.subarray(chunk.byteLength - this.maxBytes) : chunk;
    this.chunks.push(kept);
    this.bytes += kept.byteLength;
    // 去掉队首整块之后仍够 maxBytes，队首就不可能再出现在尾部里。
    while (this.chunks.length > 1 && this.bytes - this.chunks[0]!.byteLength >= this.maxBytes) {
      this.bytes -= this.chunks.shift()!.byteLength;
    }
  }

  buffer(): Buffer {
    const all = Buffer.concat(this.chunks, this.bytes);
    return all.byteLength > this.maxBytes ? all.subarray(all.byteLength - this.maxBytes) : all;
  }
}

export class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private readonly maxPersistedBytes: number;
  private readonly maxInlineBytes: number;
  private readonly maxTailBytes: number;
  private readonly legacyOutputEncoding: string | null;
  private onPersistedLimit?: () => void;
  private readonly outputPath?: string;
  private readonly persistOutput: OutputPersistenceMode;
  private readonly aggregatePersistedBudget?: AggregatePersistedOutputBudget;
  private readonly requestedTail?: ByteTail;
  private stream?: WriteStream;
  private artifactBytes = 0;
  private artifactTruncated = false;
  private inlineBytes = 0;
  private persistenceActive = false;
  private tail = Buffer.alloc(0);
  private totalBytes = 0;
  private truncated = false;

  constructor(options: {
    maxInlineBytes: number;
    maxPersistedBytes: number;
    legacyOutputEncoding: string | null;
    maxTailBytes: number;
    onPersistedLimit?: () => void;
    outputPath?: string;
    persistOutput: OutputPersistenceMode;
    aggregatePersistedBudget?: AggregatePersistedOutputBudget;
    /** 请求级尾部字节数（`outputLimit.tailBytes`）；缺席或 <= 0 即不保留、result 不带 tail。 */
    requestedTailBytes?: number;
  }) {
    this.maxInlineBytes = Math.max(0, options.maxInlineBytes);
    this.maxPersistedBytes = Math.max(0, options.maxPersistedBytes);
    this.maxTailBytes = Math.max(0, options.maxTailBytes);
    this.legacyOutputEncoding = options.legacyOutputEncoding;
    this.onPersistedLimit = options.onPersistedLimit;
    this.outputPath = options.outputPath;
    this.persistOutput = options.persistOutput;
    this.aggregatePersistedBudget = options.aggregatePersistedBudget;
    if (options.requestedTailBytes !== undefined && options.requestedTailBytes > 0) {
      this.requestedTail = new ByteTail(options.requestedTailBytes);
    }
  }

  append(chunk: Buffer, source?: NodeJS.ReadableStream): void {
    const shouldStartPersisting =
      this.persistOutput === "always" ||
      (this.persistOutput === "on_truncate" &&
        this.inlineBytes + chunk.byteLength > this.maxInlineBytes);

    if (shouldStartPersisting) this.activatePersistence(source);

    this.totalBytes += chunk.byteLength;
    this.appendTail(chunk);
    this.requestedTail?.append(chunk);

    if (this.inlineBytes >= this.maxInlineBytes) {
      this.truncated = this.truncated || chunk.byteLength > 0;
      if (this.persistenceActive) this.writePersisted(chunk, source);
      return;
    }

    const remaining = this.maxInlineBytes - this.inlineBytes;
    const take = Math.min(remaining, chunk.byteLength);
    if (take > 0) {
      this.chunks.push(chunk.subarray(0, take));
      this.inlineBytes += take;
    }
    if (take < chunk.byteLength) {
      this.truncated = true;
    }
    if (this.persistenceActive) this.writePersisted(chunk, source);
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve) => {
      this.stream!.end(resolve);
    });
  }

  result(): ExecutionStreamResult {
    const hasArtifact = this.stream !== undefined;
    return {
      text: decodeExecutionOutputBuffer(
        Buffer.concat(this.chunks, this.inlineBytes),
        this.legacyOutputEncoding,
      ),
      bytes: this.totalBytes,
      truncated: this.truncated,
      artifactPath: hasArtifact ? this.outputPath : undefined,
      artifactBytes: hasArtifact ? this.artifactBytes : undefined,
      artifactTruncated: hasArtifact ? this.artifactTruncated : undefined,
      ...(this.requestedTail
        ? {
            tail: decodeExecutionOutputBuffer(
              this.requestedTail.buffer(),
              this.legacyOutputEncoding,
            ),
          }
        : {}),
    };
  }

  get bytes(): number {
    return this.totalBytes;
  }

  tailText(): string | undefined {
    if (this.tail.length === 0) return undefined;
    return decodeExecutionOutputBuffer(this.tail, this.legacyOutputEncoding);
  }

  private appendTail(chunk: Buffer): void {
    if (this.maxTailBytes <= 0 || chunk.byteLength === 0) return;
    const next = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk]);
    this.tail =
      next.byteLength > this.maxTailBytes
        ? Buffer.from(next.subarray(next.byteLength - this.maxTailBytes))
        : Buffer.from(next);
  }

  private ensurePersistedStream(): void {
    if (this.stream || !this.outputPath || this.maxPersistedBytes <= 0) return;

    mkdirSync(dirname(this.outputPath), { recursive: true });
    this.stream = createWriteStream(this.outputPath, { flags: "w" });
    this.stream.on("error", () => {
      this.artifactTruncated = true;
    });
  }

  private activatePersistence(source?: NodeJS.ReadableStream): void {
    if (this.persistenceActive) return;
    this.ensurePersistedStream();
    if (!this.stream) return;
    this.persistenceActive = true;
    for (const chunk of this.chunks) {
      this.writePersisted(chunk, source);
    }
  }

  private writePersisted(chunk: Buffer, source?: NodeJS.ReadableStream): void {
    if (!this.stream || chunk.byteLength === 0 || this.artifactTruncated) {
      return;
    }

    // 通用 pipe 执行仍在写盘前限制单路和共享预算；Bash 文件软阈值不经过这里。
    const streamRemaining = this.maxPersistedBytes - this.artifactBytes;
    const aggregateRemaining = this.aggregatePersistedBudget
      ? this.aggregatePersistedBudget.maxBytes - this.aggregatePersistedBudget.bytes
      : streamRemaining;
    const remaining = Math.min(streamRemaining, aggregateRemaining);
    if (remaining <= 0) {
      this.artifactTruncated = true;
      this.notifyPersistedLimit();
      return;
    }

    const take = Math.min(remaining, chunk.byteLength);
    const persistedChunk = chunk.subarray(0, take);
    this.artifactBytes += persistedChunk.byteLength;
    if (this.aggregatePersistedBudget) {
      this.aggregatePersistedBudget.bytes += persistedChunk.byteLength;
    }
    if (take < chunk.byteLength) {
      this.artifactTruncated = true;
      this.notifyPersistedLimit();
    }

    const canContinue = this.stream.write(persistedChunk);
    if (!canContinue && source) {
      source.pause();
      this.stream.once("drain", () => source.resume());
    }
  }

  private notifyPersistedLimit(): void {
    if (!this.onPersistedLimit) return;
    const callback = this.onPersistedLimit;
    this.onPersistedLimit = undefined;
    callback();
  }
}
