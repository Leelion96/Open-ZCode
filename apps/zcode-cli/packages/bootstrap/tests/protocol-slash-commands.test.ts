import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionPort, ExecutionResult } from "@zcode/contracts";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";
import { resolveZCodeCustomCommandPrompt } from "../src/custom-command-prompt.js";

describe("protocol slash command surface", () => {
  it("expands prompt custom commands without taking over reserved builtins", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-custom-command-prompt-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const userCommands = join(home, ".zcode", "commands");

    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(userCommands, { recursive: true });
      await writeCommand(userCommands, "review", "Review changes", "Review $ARGUMENTS.");
      await writeCommand(userCommands, "init", "Custom init", "Should not expand.");
      await writeCommand(userCommands, "model", "Reserved model", "Should not expand.");
      await writeCommand(userCommands, "plan", "Reserved Plan action", "Should not expand.");

      const options = {
        env: { ZCODE_ENV: "test" },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      };
      const prompt = await resolveZCodeCustomCommandPrompt("/review src packages", options);

      expect(prompt).toContain("Run custom command /review.");
      expect(prompt).toContain("Command source: user/zcode.");
      expect(prompt).toContain("Review src packages.");
      await expect(resolveZCodeCustomCommandPrompt("/model glm-5", options)).resolves.toBe(
        undefined,
      );
      await expect(resolveZCodeCustomCommandPrompt("/plan task", options)).resolves.toBe(undefined);
      expect(resolveZCodeBuiltinPromptCommand("/plan task", { workingDirectory: workspace })).toBe(
        undefined,
      );
      await expect(resolveZCodeCustomCommandPrompt("/init", options)).resolves.toBe(undefined);
      await expect(resolveZCodeCustomCommandPrompt("please /review", options)).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // DWG-03：灰度关闭时 `/workflow` 不得展开。目录侧已经剃掉了它，但用户仍可手打命令名，
  // 两条路径必须给出同一个结论；同时 `workflow` 是保留名，自定义命令解析对它一律不展开，
  // 用户或插件的同名命令既顶替不了内置语义，也绕不过灰度门。
  it("expands builtin /workflow through the builtin resolver only, gated by the feature flag", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-builtin-workflow-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const userCommands = join(home, ".zcode", "commands");
    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(userCommands, { recursive: true });
      await writeCommand(userCommands, "workflow", "Shadowing workflow", "Should not expand.");
      const options = {
        env: { ZCODE_ENV: "test" },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      };

      const expanded = resolveZCodeBuiltinPromptCommand("/workflow ship it", {
        dynamicWorkflowEnabled: true,
        workingDirectory: workspace,
      });
      expect(expanded).toContain("Required skills: `dynamic-workflows`.");
      expect(expanded).toContain("ship it");
      expect(expanded).not.toContain("Should not expand.");
      // 缺席（TUI / headless）等于开启；显式 false 才挡下。
      expect(
        resolveZCodeBuiltinPromptCommand("/workflow ship it", { workingDirectory: workspace }),
      ).toContain("ship it");
      expect(
        resolveZCodeBuiltinPromptCommand("/workflow ship it", {
          dynamicWorkflowEnabled: false,
          workingDirectory: workspace,
        }),
      ).toBe(undefined);
      await expect(resolveZCodeCustomCommandPrompt("/workflow ship it", options)).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it.each([
    [true, true, ".review-product", ".review-product"],
    [true, false, ".review-product", ".zcode"],
    [false, true, ".zcode", ".review-product"],
    [false, false, ".zcode", ".zcode"],
  ] as const)(
    "keeps /init paths consistent (user=%s, project=%s)",
    async (isolateUserData, isolateProjectData, userDirectory, projectDirectory) => {
      vi.stubGlobal("__ZCODE_PRODUCT_CONFIG__", {
        name: "Review Product",
        appId: "dev.review.product",
        customizeIdentity: false,
        isolateUserData,
        isolateProjectData,
      });
      vi.resetModules();
      try {
        const { resolveZCodeBuiltinPromptCommand: resolvePrompt } =
          await import("../src/builtin-prompt-command.js");
        const { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES } = await import("@zcode/shared");
        const prompt = resolvePrompt("/init keep existing instructions", {
          workingDirectory: "/repo",
        })!;
        expect(prompt).toContain(join("/repo", projectDirectory, "AGENTS.md"));
        expect(prompt).toContain(
          `1. First check whether ${projectDirectory}/AGENTS.md or .agents/AGENTS.md exists`,
        );
        expect(prompt).toContain(`Do not write ~/${userDirectory}/AGENTS.md.`);
        expect(prompt).toContain(join("/repo", "AGENTS.md"));
        expect(prompt).toContain("keep existing instructions");
        const help = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find(
          (entry) => entry.name === "init",
        )!;
        expect(help.details.join("\n")).toContain(`~/${userDirectory}/AGENTS.md`);
      } finally {
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    },
  );

  it("expands builtin /init into the workspace AGENTS.md prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-builtin-init-"));
    const workspace = join(tempRoot, "workspace");

    try {
      await mkdir(workspace, { recursive: true });
      const prompt = resolveZCodeBuiltinPromptCommand("/init include pnpm scripts", {
        workingDirectory: workspace,
      });

      expect(prompt).toContain("built-in /init command");
      expect(prompt).toContain("AGENTS.md");
      expect(prompt).toContain(join(workspace, "AGENTS.md"));
      expect(prompt).toContain(join(workspace, ".zcode", "AGENTS.md"));
      expect(prompt).toContain(join(workspace, ".agents", "AGENTS.md"));
      expect(prompt).toContain("they already have an instructions file");
      expect(prompt).not.toContain("Do not create CLAUDE.md or AGNENTS.md");
      expect(prompt).toContain("include pnpm scripts");
      expect(resolveZCodeBuiltinPromptCommand("/review", { workingDirectory: workspace })).toBe(
        undefined,
      );
      expect(
        resolveZCodeBuiltinPromptCommand("please /init", { workingDirectory: workspace }),
      ).toBe(undefined);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("fails shell-expanded custom commands that request unavailable contexts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-command-shell-missing-context-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const userCommands = join(home, ".zcode", "commands");
    let executionCalled = false;
    const executionPort: ExecutionPort = {
      async run() {
        executionCalled = true;
        return createExecutionResult("should not run");
      },
    };

    try {
      await mkdir(userCommands, { recursive: true });
      await writeCommand(
        userCommands,
        "skill-context",
        "Needs skill context",
        ["```!", 'echo "${CLAUDE_SKILL_DIR}"', "```"].join("\n"),
      );
      await writeCommand(
        userCommands,
        "session-context",
        "Needs session context",
        ["```!", 'echo "${CLAUDE_SESSION_ID}"', "```"].join("\n"),
      );

      const options = {
        env: { ZCODE_ENV: "test" },
        executionPort,
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      };

      await expect(resolveZCodeCustomCommandPrompt("/skill-context", options)).rejects.toThrow(
        "Custom command /skill-context variable requires a skill context: CLAUDE_SKILL_DIR",
      );
      await expect(resolveZCodeCustomCommandPrompt("/session-context", options)).rejects.toThrow(
        "Custom command /session-context variable requires a runtime session context: CLAUDE_SESSION_ID",
      );
      expect(executionCalled).toBe(false);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

async function writeCommand(
  directory: string,
  name: string,
  description: string,
  body: string,
  extraFrontmatter: string[] = [],
): Promise<void> {
  await writeFile(
    join(directory, `${name}.md`),
    ["---", `description: ${description}`, ...extraFrontmatter, "---", "", body].join("\n"),
  );
}

function createExecutionResult(stdout: string): ExecutionResult {
  const now = new Date();
  return {
    status: "completed",
    exitCode: 0,
    stdout: { text: stdout, bytes: stdout.length, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: now,
    completedAt: now,
  };
}
