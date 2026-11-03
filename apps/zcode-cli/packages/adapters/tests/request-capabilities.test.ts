import { expect, it } from "vitest";
import { resolveModelRequestCapabilities } from "../src/model/tool-search.js";

it.each([
  ["anthropic-messages", true],
  ["openai-chat-completions", false],
  ["openai-responses", false],
])("folds reminders into tool results only on the Anthropic protocol (%s)", (apiType, fold) => {
  const capabilities = resolveModelRequestCapabilities(apiType, { type: "api-key" });
  expect(capabilities.foldRemindersIntoToolResults).toBe(fold);
  expect(capabilities.toolSearch?.protocolSupported).toBe(fold);
});
