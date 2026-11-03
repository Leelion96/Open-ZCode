import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface WireMessage {
  role: string;
  content: unknown;
}
export type Presentation =
  | "user_steer"
  | "coordinator_input"
  | "coordinator_steer"
  | "subagent_reply_steer"
  | "subagent_reply"
  | "task_notification"
  | "task_notification_steer";

export function wireText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block?.type === "text") return String(block.text ?? "");
      // Anthropic 协议下紧随 tool result 的提醒并入 tool_result.content。
      if (block?.type === "tool_result") return wireText(block.content);
      return "";
    })
    .join("\n");
}

/** 验证实际网络载荷；黄金样本独立于生产 formatter。 */
export async function assertIncomingMessage(
  request: unknown,
  input: {
    presentation: Presentation;
    marker: string;
    role: "user" | "system";
    body?: string;
    evidenceLabel?: string;
    /**
     * MCS 下没有 user/tool 锚点（例如 text-only 回复之后）时，同一段 run 的 MCS 文本整组降级为
     * 一条 user reminder，只包一次；期望文本是其中完整的一段。
     */
    mcsFallback?: boolean;
  },
) {
  const fixture = await readPresentationFixture();
  await saveWireEvidence(
    request,
    `${input.evidenceLabel ?? "default"}-${input.presentation}-${input.marker}`,
  );
  const messages = (request as { messages: WireMessage[] }).messages;
  assertWireIntegrity(request);
  // 模板固定取标准样本，不从 wire 反推：反推时 CLI 选错模板也能通过。
  // 同轮标题（fixture.inHumanTurn）只用于紧跟真实用户消息、中间没有 assistant/tool result 的中途通知，
  // 由 CLI 单测覆盖；现有 E2E 的中途通知都在 assistant 或 tool result 之后送达。
  const template = fixture.expected[input.presentation];
  const prefix = template.split("{body}")[0]!;
  const index = messages.findIndex(
    (message) =>
      wireText(message.content).includes(prefix) &&
      wireText(message.content).includes(input.marker),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  const message = messages[index]!;
  const text = wireText(message.content);
  const body =
    input.body ??
    (input.presentation.startsWith("subagent")
      ? text.match(/<subagent-message>[\s\S]*?<\/subagent-message>/u)?.[0]
      : text.match(/<task-notification>[\s\S]*?<\/task-notification>/gu)?.join("\n\n"));
  expect(body).toBeDefined();
  const midTurn = input.presentation.endsWith("_steer");
  const wrapped =
    input.role === "user" &&
    (input.presentation.endsWith("_steer") || input.presentation === "task_notification");
  // 独立校验 provider 表达；提取自 wire 的正文可能已转义，不能再次编码实体。
  // 新轮整批通知每条一个 text block，各自带标题和一对标签；单条时只有一段。
  const wireBodies = (
    input.presentation === "task_notification" && input.body === undefined
      ? text.match(/<task-notification>[\s\S]*?<\/task-notification>/gu)!
      : [body!]
  ).map((part) => (wrapped ? part.replace(/<(\/?system-reminder\b)/gi, "&lt;$1") : part));
  const expectedParts = wireBodies.map((part) => template.replace("{body}", part));
  for (const expected of expectedParts) {
    expect(
      messages.reduce(
        (count, item) => count + wireText(item.content).split(expected).length - 1,
        0,
      ),
    ).toBe(1);
    expect(text).toContain(expected);
  }
  expect(message.role).toBe(input.role);
  // 整批时除最后一块外，每块末尾一个 "\n"。
  const expectedBlocks = wrapped
    ? expectedParts.map(
        (part, index) =>
          `<system-reminder>\n${part}\n</system-reminder>${index < expectedParts.length - 1 ? "\n" : ""}`,
      )
    : [expectedParts.join("\n")];
  const expectedBlock = expectedBlocks.join("");
  if (input.presentation !== "coordinator_input") {
    const blocks =
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "text").map((block) => block.text)
          : [];
    const toolResults = Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "tool_result")
      : [];
    if (input.role === "system") {
      // MCS 下同一段 user run 的 system 文本合并为一条、以空行分隔（后续公告可能并入）；
      // 期望文本必须是其中完整的一段，前后不能夹入其他文案。
      const merged = blocks.find((block) => block.includes(expectedBlock));
      expect(merged).toBeDefined();
      expect(`\n\n${merged}\n\n`).toContain(`\n\n${expectedBlock}\n\n`);
    } else if (input.mcsFallback) {
      // 降级块只有一对外层标签，期望文本是标签内以空行分隔的完整一段。
      const inner = expectedParts.join("\n\n");
      const fallback = blocks.find((block) => block.includes(inner));
      expect(fallback?.startsWith("<system-reminder>\n")).toBe(true);
      expect(fallback?.endsWith("\n</system-reminder>")).toBe(true);
      const body = fallback!.slice("<system-reminder>\n".length, -"\n</system-reminder>".length);
      expect(`\n\n${body}\n\n`).toContain(`\n\n${inner}\n\n`);
      expect(fallback!.match(/<\/?system-reminder\b/gi)).toHaveLength(2);
    } else if (wrapped && midTurn && toolResults.length > 0) {
      // 中途消息紧随 tool result 时并入最后一个 tool_result.content，以空行与其他段分隔。
      expect(blocks).not.toContain(expectedBlock);
      const folded = wireText(toolResults.at(-1)!.content);
      expect(`\n\n${folded}\n\n`).toContain(`\n\n${expectedBlock}\n\n`);
    } else {
      // 精确比较完整 block 序列，防止正确模板前后夹入额外控制文案。
      const start = blocks.indexOf(expectedBlocks[0]!);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(blocks.slice(start, start + expectedBlocks.length)).toEqual(expectedBlocks);
    }
    // 并入 tool result 的 block 已在上面逐字比较，这里只检查独立的 text block：每块只有一对标签。
    if (wrapped && !(midTurn && toolResults.length > 0) && !input.mcsFallback) {
      const actualBlock = blocks.find(
        (block) => block.includes(prefix) && block.includes(input.marker),
      );
      expect(actualBlock?.match(/<\/?system-reminder\b/gi)).toHaveLength(2);
    }
  }

  // 只统计 text block，工具入参中的同名载荷不算第二份输入。
  for (const wireBody of wireBodies) {
    expect(
      messages.reduce(
        (count, item) => count + wireText(item.content).split(wireBody).length - 1,
        0,
      ),
    ).toBe(1);
  }
  if (input.role === "system") expect(text).not.toContain(`<system-reminder>\n${prefix}`);
  // wireText 以 "\n" 连接各 text block；降级块已在上面逐段校验。
  else if (wrapped && !input.mcsFallback) expect(text).toContain(expectedBlocks.join("\n"));
  else if (!wrapped) expect(text).not.toContain(`<system-reminder>\n${expectedParts[0]}`);
  return { index, messages };
}

async function readPresentationFixture() {
  return JSON.parse(
    await readFile(
      new URL(
        "../../../../../apps/zcode-cli/packages/core/tests/fixtures/runtime-input-presentation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { expected: Record<Presentation, string> };
}

async function saveWireEvidence(request: unknown, label: string): Promise<void> {
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (!artifactDir) return;
  const directory = join(artifactDir, "incoming-message-wire");
  await mkdir(directory, { recursive: true });
  const name = `${label.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 160)}.json`;
  // 只保存实际 provider JSON body；不持久化网络凭据或 headers。
  await writeFile(join(directory, name), `${JSON.stringify(request, null, 2)}\n`, "utf8");
}

/**
 * 运行中立即发送抢占后是普通用户输入：独立 text block、整个请求里只出现一次，
 * 没有人类中途提示，也不并入 tool_result。
 */
export async function assertPlainUserInput(
  request: unknown,
  input: { body: string; evidenceLabel: string },
) {
  await saveWireEvidence(request, `${input.evidenceLabel}-plain-user`);
  const messages = (request as { messages: WireMessage[] }).messages;
  assertWireIntegrity(request);
  const index = messages.findIndex((message) => textBlocksOf(message.content).includes(input.body));
  expect(index).toBeGreaterThanOrEqual(0);
  expect(messages[index]!.role).toBe("user");
  expect(
    messages.reduce(
      (count, item) => count + wireText(item.content).split(input.body).length - 1,
      0,
    ),
  ).toBe(1);
  const steerPrefix = (await readPresentationFixture()).expected.user_steer.split("{body}")[0]!;
  expect(JSON.stringify(request)).not.toContain(JSON.stringify(steerPrefix).slice(1, -1));
  return { index, messages };
}

/**
 * 后一次请求只在前一次请求末尾追加：前面的消息逐条相同，前一次最后一条消息的 block
 * 是后一次同位置消息的前缀。缓存断点（cache_control）随请求移动，不参与比较。
 */
export function assertAppendOnly(previousRequest: unknown, nextRequest: unknown): void {
  const strip = (value: unknown) =>
    JSON.parse(JSON.stringify(value, (key, item) => (key === "cache_control" ? undefined : item)));
  const previous = strip(
    (previousRequest as { messages: WireMessage[] }).messages,
  ) as WireMessage[];
  const next = strip((nextRequest as { messages: WireMessage[] }).messages) as WireMessage[];
  expect(next.length).toBeGreaterThanOrEqual(previous.length);
  expect(next.slice(0, previous.length - 1)).toEqual(previous.slice(0, -1));
  const last = previous.at(-1)!;
  const blocksOf = (content: unknown) =>
    typeof content === "string" ? [{ type: "text", text: content }] : (content as unknown[]);
  const lastBlocks = blocksOf(last.content);
  expect(next[previous.length - 1]!.role).toBe(last.role);
  expect(blocksOf(next[previous.length - 1]!.content).slice(0, lastBlocks.length)).toEqual(
    lastBlocks,
  );
}

function textBlocksOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "text").map((block) => String(block.text));
}

/** 系统中途消息不能拆开并行工具的结果批次，也不能泄漏内部来源字段。 */
export function assertWireIntegrity(request: unknown): void {
  const messages = (request as { messages: WireMessage[] }).messages;
  expect(JSON.stringify(request)).not.toMatch(
    /"(?:inputPresentation|steerContext|sourceEntries)"\s*:/u,
  );
  const pending = new Set<string>();
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const results = blocks.filter((block) => block.type === "tool_result");
    if (pending.size > 0) {
      expect(message.role).toBe("user");
      expect(results.map((block) => block.tool_use_id).sort()).toEqual([...pending].sort());
      pending.clear();
    } else {
      expect(results).toHaveLength(0);
    }
    for (const block of blocks) {
      if (block.type === "tool_use") pending.add(block.id);
    }
    expect(wireText(message.content).length > 0 || blocks.length > 0).toBe(true);
  }
  expect([...pending]).toHaveLength(0);
}

/** 既有后台生命周期用例共用全文断言；角色分支另由双能力时序矩阵固定验证。 */
export async function assertTaskNotificationContents(
  request: unknown,
  evidenceLabel: string,
): Promise<void> {
  const messages = (request as { messages: WireMessage[] }).messages;
  for (const [index, message] of messages.entries()) {
    const text = wireText(message.content);
    const bodies = text.match(/<task-notification>[\s\S]*?<\/task-notification>/gu);
    if (!bodies?.length) continue;
    expect(["user", "system"]).toContain(message.role);
    const body = bodies.join("\n\n");
    const marker = bodies[0]!.match(/<task-id>([^<]+)<\/task-id>/u)?.[1];
    expect(marker).toBeTruthy();
    // user 的中途降级与新轮通知现在使用相同包装，不能再根据标签推断消费时机。
    // 此处只验证全文；实际时序及角色仍由 BG25/BG36 双能力用例单独固定。
    // 并入 tool_result.content 的只能是中途通知（新轮通知是输入，不折叠）。
    const blocks = Array.isArray(message.content) ? message.content : [];
    const folded = blocks.some(
      (block) => block?.type === "tool_result" && wireText(block.content).includes(bodies[0]!),
    );
    const mid = message.role === "system" || folded;
    await assertIncomingMessage(request, {
      presentation: mid ? "task_notification_steer" : "task_notification",
      marker: marker!,
      // 修复原因：新轮通知每条各带标题和一对标签，传入拼接后的 body 会被当成一段校验，
      // 一条消息里有 2 条以上通知时误报失败。新轮不传 body，交给按条拆分的分支。
      body: mid ? body : undefined,
      role: message.role as "system" | "user",
      evidenceLabel: `${evidenceLabel}-${index}`,
    });
  }
}
