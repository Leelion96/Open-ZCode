import { expect, it } from "vitest";
import { createLocalRecorder } from "./contract.example.js";

it("无观测上下文的命令不建立阶段事实", () => {
  const facts: unknown[] = [];
  const recorder = createLocalRecorder((fact) => facts.push(fact));
  try {
    recorder.receive(
      {
        commandId: "command",
        clientId: "client",
        sessionId: "session",
        type: "sendText",
        payload: {},
        issuedAt: 1,
      },
      false,
    );
    expect(facts).toEqual([]);
    expect(recorder.forSession("session")).toBeUndefined();
  } finally {
    recorder.clear();
  }
});
