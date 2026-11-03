import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { closeSessionResources } from "../src/app/session-facade.js";

describe("session facade shutdown", () => {
  it("closes independent resources but keeps store until a slow resource actually settles", async () => {
    const gate = Promise.withResolvers<void>();
    const events: string[] = [];
    const warn = vi.fn();
    const closePromise = closeSessionResources({
      beginShutdown: () => events.push("admission_closed"),
      closeBrowserSession: async () => {
        events.push("browser_started");
        await gate.promise;
      },
      closeExecution: async () => {
        events.push("execution_closed");
      },
      closeMcp: async () => {
        events.push("mcp_closed");
      },
      closeNodeReplBrowserBroker: async () => {
        events.push("broker_closed");
      },
      closeSessionStore: () => events.push("store_closed"),
      logger: { warn } as never,
      timeoutMs: 25,
    });

    const failed = expect(closePromise).rejects.toThrow("timed out");
    await sleep(5);
    expect(events).toEqual([
      "admission_closed",
      "browser_started",
      "execution_closed",
      "mcp_closed",
      "broker_closed",
    ]);

    await failed;

    expect(events).not.toContain("store_closed");
    gate.resolve();
    await sleep(0);
    expect(events.at(-1)).toBe("store_closed");
    expect(warn).toHaveBeenCalledWith(
      "Session resource close timed out",
      expect.objectContaining({
        event: "session.resource_close.timed_out",
        resource: "session_resources",
      }),
    );
  });

  it("isolates close failures and still closes the session store", async () => {
    const events: string[] = [];
    const warn = vi.fn();

    await expect(
      closeSessionResources({
        beginShutdown: () => events.push("admission_closed"),
        closeBrowserSession: async () => {
          throw new Error("browser failed");
        },
        closeExecution: async () => events.push("execution_closed"),
        closeMcp: async () => {
          throw new Error("mcp failed");
        },
        closeSessionStore: () => events.push("store_closed"),
        logger: { warn } as never,
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(events).toEqual(["admission_closed", "execution_closed", "store_closed"]);
    expect(warn).toHaveBeenCalledWith(
      "Session resource close failed",
      expect.objectContaining({ resource: "mcp" }),
    );
  });
});
