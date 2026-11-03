import { describe, expect, it } from "vitest";
import type { EnvInfo } from "@zcode/contracts";
import { createContextBuilder } from "../src/context/builder.js";
import { createSubagentContextBuilder } from "../src/subagent/context-builder.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

const envInfo: EnvInfo = {
  cwd: "/workspace",
  platform: "linux",
  shell: "bash",
  osVersion: "Linux",
  nodeVersion: "v24",
};
const model = createTestRuntimeModel({
  providerId: "actual-provider",
  modelId: "shared-name",
  generateText: async () => {
    throw new Error("context building must not call the provider");
  },
});

describe("Context execution model source", () => {
  it("shares environment and model sections with subagents and custom system prompts", () => {
    const main = createContextBuilder({ envInfo, model, workingDirectory: envInfo.cwd }).build();
    const child = createSubagentContextBuilder({
      envInfo,
      model,
      agentPrompt: "Child-only identity.",
    }).build();
    const custom = createContextBuilder({
      envInfo,
      model,
      workingDirectory: envInfo.cwd,
      customSystemPrompt: "Host override.",
    }).build();
    const runtimeContext = (result: typeof main) =>
      result.sections.filter(
        (section) => section.source === "env_info" || section.source === "model",
      );
    expect(runtimeContext(child)).toEqual(runtimeContext(main));
    expect(runtimeContext(child).map((section) => section.injectionTarget)).toEqual([
      "meta_user",
      "meta_user",
    ]);
    // 自定义 prompt 只替换 system 正文，环境与模型公告照常发送。
    expect(runtimeContext(custom)).toEqual(runtimeContext(main));
    expect(child.metaUserAttachments).toEqual([]);
    const initial = child.systemMessages.map((message) => message.content).join("");
    expect(initial).toMatch(
      /Child-only identity\.\n\nMessages from the agent that launched you — .+\n\nNotes:/u,
    );
    expect(initial).not.toContain("# Environment");
    expect(initial).not.toContain("<env>");
    expect(initial).not.toContain("You are powered by");
    expect(
      child.sections.some(
        (section) =>
          section.source === "session_context" ||
          section.source === "memory" ||
          section.source === "desktop_context",
      ),
    ).toBe(false);
  });
  for (const kind of ["main", "subagent"] as const) {
    const build = (source: EnvInfo, withModel: boolean) => {
      const config = { envInfo: source, model: withModel ? model : undefined };
      const result =
        kind === "main"
          ? createContextBuilder({ ...config, workingDirectory: "/workspace" }).build()
          : createSubagentContextBuilder({
              ...config,
              agentPrompt: "Inspect the workspace.",
            }).build();
      // 环境与模型身份只产出 section，由运行时宣告。
      return [...result.systemMessages, ...result.sections]
        .map((item) => String(item.content))
        .join("\n");
    };

    it(`${kind} renders the actual Model without putting model identity into EnvInfo`, () => {
      expect(build(envInfo, true)).toContain(
        "powered by the model named actual-provider/shared-name",
      );
      expect(envInfo).not.toHaveProperty("currentModel");
    });

    it(`${kind} ignores a legacy environment model even when no execution Model exists`, () => {
      // 旧持久化数据可能带额外字段；它不能重新成为模型说明的输入。
      const legacyEnvironment = { ...envInfo, currentModel: "legacy/wrong-model" };
      expect(build(legacyEnvironment, false)).not.toContain("powered by the model named");
      expect(build(legacyEnvironment, true)).not.toContain("legacy/wrong-model");
      expect(build(legacyEnvironment, true)).toContain("actual-provider/shared-name");
    });
  }
});
