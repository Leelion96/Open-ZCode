import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledNpmRootCandidates,
  resolveMcpNodeFallbackProvider,
} from "../src/app/mcp-node-fallback.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function writeNpmPackage(npmRoot: string): Promise<void> {
  await mkdir(join(npmRoot, "bin"), { recursive: true });
  await writeFile(join(npmRoot, "bin", "npm-cli.js"), "");
  await writeFile(join(npmRoot, "bin", "npx-cli.js"), "");
}

describe("bundledNpmRootCandidates", () => {
  it("looks next to the entry file first, then next to the bundle, without duplicates", () => {
    expect(
      bundledNpmRootCandidates(["/app/resources/glm", "/app/other", "/app/resources/glm"]),
    ).toEqual([
      join("/app/resources/glm", "node-runtime", "npm"),
      join("/app/other", "node-runtime", "npm"),
    ]);
  });
});

describe("resolveMcpNodeFallbackProvider", () => {
  it("returns no provider when the agent does not run on Electron Node", () => {
    expect(
      resolveMcpNodeFallbackProvider({
        cliStorageRoot: "/storage/cli",
        runtime: { baseDirs: ["/app"], electronVersion: undefined, execPath: "/usr/bin/node" },
      }),
    ).toBeUndefined();
  });

  it("uses the Electron executable and the staged npm next to the agent bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-node-fallback-"));
    tempRoots.push(root);
    const glmDir = join(root, "resources", "glm");
    await writeNpmPackage(join(glmDir, "node-runtime", "npm"));

    const provider = resolveMcpNodeFallbackProvider({
      cliStorageRoot: join(root, "cli"),
      runtime: {
        baseDirs: [join(root, "missing"), glmDir],
        electronVersion: "44.7.0",
        execPath: process.execPath,
      },
    });

    await expect(provider?.resolve()).resolves.toEqual({
      binDir: join(root, "cli", "node-fallback", "v1"),
      env: {
        ZCODE_NODE_FALLBACK_EXEC_PATH: process.execPath,
        ZCODE_NODE_FALLBACK_NPM_ROOT: join(glmDir, "node-runtime", "npm"),
      },
    });
  });
});
