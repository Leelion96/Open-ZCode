// ============================================================
// Workflow Actor Identity Section Builder
// ============================================================
//
// 动态工作流子代理（workflow child）的身份段。
//
// 它替换的是主会话面向用户目标的 Agent Identity：子代理的读者是脚本，不是人。
// 它**不**替换基座的其他段——安全 IMPORTANT 行与
// `# Harness` 块从 identity 逐字复用，memory / skills / 项目指令由 builder 照常追加。
// 作者写的 persona 叠加在开场句之后、契约之前：角色比通用规则更靠前、更醒目，但开场句先把
// 「你是谁的谁、输出给谁」说死，persona 不能推翻它。
//
// 契约曾按 persona 的工具档位分支；实盘里零工具的 GLM 子代理被
// 「Ground every claim in something you read or ran」逼着去读目录、跑命令，而它没有这些工具，
// 于是发出一个退化的 `escalate("placeholder")`。修法是**把工具面说死**：子代理先知道自己有什么，
// 再被告知证据从哪来。工具档位退场后，
// 每个子代理都有完整工作工具集，契约回到一份文本；「说死工具面」的原则不变。

import type { ContextSection, WorkflowActorContext } from "../types.js";
import { estimateTokens } from "../utils.js";
import { buildHarnessBlock, buildSecurityNotice } from "./identity.js";

/** 工具面的自述：一句「有什么」+ 一句「没有什么」，让模型不去猜。 */
const TOOL_SURFACE =
  "You have the regular working tools — reading, searching, editing, running commands — plus `submit_result` and `escalate`. There is no tool that asks a person anything.";

/** 证据标准：引用读过/跑过的东西，ask 自带材料时引用材料；跑过才算过，按 ask 点名的尺度跑。 */
const EVIDENCE_RULE =
  // 「跑过才算过」管的是诚实，不管尺度——
  // 实盘子代理拿一个测试文件、一次 build 顶替 ask 点名的整套件。补一句管尺度。
  "Ground every claim in something you read or ran in this session, or in the material the ask gave you, and say which. Cite code as `path:line`. A check counts as passed only if you executed it here; if you could not run it, report it as not run. Run the check an ask names rather than a faster substitute, and say exactly which command you ran.";

function buildWorkflowContract(): string {
  return [
    "# Working inside a workflow",
    `- ${TOOL_SURFACE}`,
    "- Each ask states what to do. When the ask carries a result schema, finish by calling `submit_result` with a conforming value; otherwise your final message is the result.",
    `- ${EVIDENCE_RULE}`,
    "- Report outcomes faithfully. If part of the task is impossible, out of scope, or contradicted by what you found, say so in the result instead of filling a field with a plausible guess. Never fake a passing result to satisfy an instruction.",
    "- When you are blocked by something outside your reach — a gate that cannot pass, instructions that contradict each other, a fact only the run's owner knows — call `escalate`. Questions written in prose reach nobody.",
    // 产物条款把「子代理写下的文件」从既被劝阻、又不被追踪，
    // 变成一条有出口的通道：子代理仍然没有任何产物工具（只有脚本能发布，信任边界不动），但
    // 当 ask 指名了输出路径时，写到那里并把路径交回来，脚本会把它发布给用户。
    "- Do not write report or summary files on your own initiative; findings go in the result. When the ask names an output path, write exactly there and return that path in the result — the script publishes it to the user.",
  ].join("\n");
}

function buildWorkflowActorIdentityPrompt(
  actor: WorkflowActorContext,
  midConversationSystem: boolean,
): string {
  const name = actor.name?.trim();
  const named = name ? `, named "${name}"` : "";
  const opening = [
    `You are a subagent inside a dynamic workflow run${named}. A script created you and hands you work one ask at a time; the script — not a person — consumes what you return. There is no user in this conversation to talk to.`,
  ];
  const persona = actor.persona?.trim();
  // 工作流子代理不使用面向用户交互的产品前缀，
  // 所以这一段就是 system 的第一行，不再以空行起头。
  const parts = [
    opening.join("\n"),
    ...(persona ? ["", persona] : []),
    "",
    buildSecurityNotice(),
    "",
    buildHarnessBlock(midConversationSystem),
    "",
    buildWorkflowContract(),
  ];
  return parts.join("\n");
}

export function buildWorkflowActorIdentitySection(
  actor: WorkflowActorContext,
  midConversationSystem = true,
): ContextSection {
  const content = buildWorkflowActorIdentityPrompt(actor, midConversationSystem);
  return {
    name: "Workflow Actor Identity",
    source: "workflow_actor_identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
