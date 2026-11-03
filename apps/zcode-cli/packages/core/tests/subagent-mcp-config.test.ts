import { describe, expect, it } from "vitest";
import { matchesRequiredMcpServer, parseAgentMcpServers } from "../src/subagent/mcp-config.js";

describe("subagent MCP config", () => {
  it("matches connected plugin MCP servers against their model-visible tool name prefix", () => {
    expect(
      matchesRequiredMcpServer("plugin_android-emulator_android-emulator", {
        "plugin:android-emulator:android-emulator": {
          status: "connected",
          toolCount: 1,
          transport: "stdio",
          updatedAt: new Date(0).toISOString(),
        },
      }),
    ).toBe(true);
  });
});

it("inline subagent MCP cannot claim Host-owned provenance to bypass workspace trust", () => {
  const trusted = {
    type: "stdio" as const,
    command: "node",
    source: { kind: "workspace" as const },
  };
  expect(parseAgentMcpServers(["known"], { known: trusted }).scopedServers.known).toBe(trusted);
  for (const kind of ["user", "plugin", "builtin"]) {
    const result = parseAgentMcpServers(
      [{ known: { type: "stdio", command: "node", source: { kind } } }],
      {},
    );
    expect(result.scopedServers).toEqual({});
    expect(result.invalidServerNames).toEqual(["known"]);
  }
});
