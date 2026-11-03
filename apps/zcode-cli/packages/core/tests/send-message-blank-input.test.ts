import { expect, it } from "vitest";
import {
  HookEventName,
  createSessionId,
  createToolCallId,
  createTurnId,
  type SubagentPort,
} from "@zcode/contracts";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { sendMessageToolEntry } from "../src/tool/handlers/send-message.js";
import { createToolRegistry } from "../src/tool/registry.js";

it("rejects a whitespace-only message before hooks, permission and delivery", async () => {
  const hookEvents: string[] = [];
  const deliveries: unknown[] = [];
  const registry = createToolRegistry();
  registry.register(sendMessageToolEntry);
  const executor = createToolExecutor({
    emitEvent: async () => {},
    hookRunner: createInMemoryHookRunner({
      hooks: [HookEventName.PreToolUse, HookEventName.PostToolUseFailure].map((event) => ({
        event,
        matcher: "SendMessage",
        callback: async (input) => {
          hookEvents.push(input.hookEventName);
          return {};
        },
      })),
    }),
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId: createSessionId("send-message-blank"),
    subagentPort: {
      sendMessage: async (request: unknown) => {
        deliveries.push(request);
        return { messageId: "message-1", status: "success" };
      },
    } as unknown as SubagentPort,
    turnId: createTurnId("turn"),
  });

  const result = await executor.execute({
    id: createToolCallId("send-blank"),
    input: { message: " \n\t ", to: "agent_1" },
    name: "SendMessage",
  });

  expect(result.success).toBe(false);
  expect(result.modelContent).toBe("<tool_use_error>message must not be empty</tool_use_error>");
  expect(hookEvents).toEqual([]);
  expect(deliveries).toEqual([]);
});
