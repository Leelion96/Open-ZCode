import { describe, expect, it } from "vitest";
import { OffPeakLifecycle, type OffPeakLifecycleEvent } from "../src/runtime/off-peak/lifecycle.js";
import { OffPeakTicketAuthority } from "../src/runtime/off-peak/model-binding.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

const expired = (code = "3102") =>
  Object.assign(new Error("expired"), {
    code: "invalid_model_request",
    context: { providerCode: code, providerId: "idle" },
  });
function fixture() {
  const events: OffPeakLifecycleEvent[] = [];
  const lifecycle = new OffPeakLifecycle({
    executionId: "execution",
    offPeakTaskId: "task",
    ticketId: "one",
    readWork: () => ({
      mainRunning: true,
      backgroundRunning: false,
      pendingNotifications: false,
      pendingInputs: false,
    }),
    emit: (event) => events.push(event),
  });
  const authority = new OffPeakTicketAuthority(lifecycle, {
    ticketId: "one",
    requestAuth: { headers: { ticket: "one" } },
    providerId: "idle",
    providerErrorCode: "3102",
  });
  return { events, lifecycle, authority };
}
const result = {
  text: "done",
  finishReason: "stop" as const,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

describe("闲时模型请求换票", () => {
  it("包装后保留原模型的全部数据字段，包括请求能力", () => {
    const { authority } = fixture();
    const requestCapabilities = { foldRemindersIntoToolResults: true } as const;
    const base = {
      ...createTestRuntimeModel({ generateText: async () => result }),
      requestCapabilities,
    };
    const wrapped = authority.createBinding().wrap({ ...base, bind: () => base });
    // 漏掉请求能力时，闲时轮不并入 tool_result、ToolSearch 按协议不支持处理，和普通轮形态不同。
    expect(wrapped.requestCapabilities).toEqual(requestCapabilities);
    expect(wrapped.bind().requestCapabilities).toEqual(requestCapabilities);
    expect(wrapped).toMatchObject({
      providerId: base.providerId,
      modelId: base.modelId,
      properties: base.properties,
      optionSpecs: base.optionSpecs,
      options: base.options,
    });
  });

  it("取消信号传到底层，关闭不结束也不吞掉取消错误", async () => {
    const { authority } = fixture();
    const binding = authority.createBinding();
    const started = Promise.withResolvers<void>();
    const stop = new Error("user stopped");
    const controller = new AbortController();
    const model = binding.wrap({
      ...createTestRuntimeModel({ generateText: async () => result }),
      streamText(request) {
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          next(): Promise<IteratorResult<never>> {
            return new Promise((_resolve, reject) => {
              request.abortSignal!.addEventListener(
                "abort",
                () => reject(request.abortSignal!.reason),
                { once: true },
              );
              started.resolve();
            });
          },
          return: () => new Promise<IteratorResult<never>>(() => {}),
        };
      },
    });
    const pending = model
      .streamText({ messages: [], abortSignal: controller.signal })
      [Symbol.asyncIterator]()
      .next();
    const rejected = expect(pending).rejects.toBe(stop);
    await started.promise;
    controller.abort(stop);
    await rejected;
    binding.release();
  });

  it.each(["reject", "pending"])("流关闭 %s 不阻塞换票，退出时取消旧请求", async (cleanup) => {
    const { authority, events } = fixture();
    const binding = authority.createBinding();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const model = binding.wrap({
      ...createTestRuntimeModel({ generateText: async () => result }),
      streamText(request) {
        signals.push(request.abortSignal!);
        const first = ++calls === 1;
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            if (first) throw expired();
            return { done: true as const, value: undefined };
          },
          return() {
            return cleanup === "reject"
              ? Promise.reject(new Error("cleanup failed"))
              : new Promise<IteratorResult<never>>(() => {});
          },
        };
      },
    });
    const pending = model.streamText({ messages: [] })[Symbol.asyncIterator]().next();
    const outcome = pending.then(
      () => "done",
      (error: Error) => error.message,
    );
    await expect.poll(() => events.some((event) => event.type === "ticket_needed")).toBe(true);
    authority.replaceTicket(1, "two", { headers: { ticket: "two" } });
    await expect.poll(() => calls).toBe(2);
    expect(await outcome).toBe("done");
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    binding.release();
  });

  it("关闭失败不覆盖原始业务错误", async () => {
    const { authority } = fixture();
    const binding = authority.createBinding();
    const original = new Error("original provider error");
    const model = binding.wrap({
      ...createTestRuntimeModel({ generateText: async () => result }),
      streamText() {
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next(): Promise<IteratorResult<never>> {
            throw original;
          },
          async return(): Promise<IteratorResult<never>> {
            throw new Error("cleanup error");
          },
        };
      },
    });
    await expect(model.streamText({ messages: [] })[Symbol.asyncIterator]().next()).rejects.toBe(
      original,
    );
    binding.release();
  });

  it.each(["3102", "3106"])("过期码 %s 通知 Host 收口，多个请求只通知一次", async (code) => {
    const { authority, events } = fixture();
    const binding = authority.createBinding();
    const tickets: string[] = [];
    const model = binding.wrap(
      createTestRuntimeModel({
        providerId: "idle",
        generateText: async (request) => {
          const auth = await binding.requestDependencies.requestAuth!.source!.resolve({
            attempt: 1,
            providerId: "idle",
            modelId: "model",
            abortSignal: request.abortSignal,
          });
          tickets.push(auth!.headers!.ticket!);
          if (auth!.headers!.ticket === "one") throw expired(code);
          return result;
        },
      }),
    );
    const request = { messages: [] };
    const pending = Promise.all([model.generateText(request), model.generateText(request)]);
    void pending.catch(() => {});
    await expect.poll(() => events.filter((e) => e.type === "ticket_needed").length).toBe(1);
    expect(authority.replaceTicket(1, "two", { headers: { ticket: "two" } })).toBe(true);
    expect(await pending).toEqual([result, result]);
    expect(tickets).toEqual(["one", "one", "two", "two"]);
    binding.release();
  });

  it("3104 无效票据直接失败，不进入换票等待", async () => {
    const { authority, events } = fixture();
    const binding = authority.createBinding();
    const error = expired("3104");
    const model = binding.wrap(
      createTestRuntimeModel({
        providerId: "idle",
        generateText: async () => {
          throw error;
        },
      }),
    );
    await expect(model.generateText({ messages: [] })).rejects.toBe(error);
    expect(events.some((event) => event.type === "ticket_needed")).toBe(false);
    binding.release();
  });

  it("用户接管不会中断持有效旧票的当前子轮，但拒绝迟到换票和下一子轮", async () => {
    const { authority, lifecycle } = fixture();
    const binding = authority.createBinding();
    lifecycle.takeOver();
    expect(
      await binding.requestDependencies.requestAuth!.source!.resolve({
        attempt: 1,
        providerId: "idle",
        modelId: "model",
      }),
    ).toEqual({ headers: { ticket: "one" } });
    expect(authority.replaceTicket(1, "late", { headers: { ticket: "late" } })).toBe(false);
    expect(() => authority.createBinding()).toThrow("off_peak_user_takeover");
    binding.release();
  });

  it("等待新票时可取消请求，已产生内容的流不从头重放", async () => {
    const { authority, events } = fixture();
    const binding = authority.createBinding();
    const model = binding.wrap(
      createTestRuntimeModel({
        providerId: "idle",
        generateText: async () => {
          throw expired();
        },
      }),
    );
    const abort = new AbortController();
    const pending = model.generateText({ messages: [], abortSignal: abort.signal });
    const rejected = expect(pending).rejects.toThrow("stop");
    await expect.poll(() => events.some((e) => e.type === "ticket_needed")).toBe(true);
    abort.abort(new Error("stop"));
    await rejected;
    binding.release();
    const other = fixture();
    const streamBinding = other.authority.createBinding();
    const streaming = streamBinding.wrap({
      ...createTestRuntimeModel({ providerId: "idle", generateText: async () => result }),
      async *streamText() {
        yield { type: "text_start" as const, id: "text" };
        throw expired();
      },
    });
    const read = async () => {
      for await (const _chunk of streaming.streamText({ messages: [] })) {
        /* 保留已交付内容 */
      }
    };
    await expect(read()).rejects.toThrow("expired");
    expect(other.events.some((e) => e.type === "ticket_needed")).toBe(false);
    streamBinding.release();
  });
});
