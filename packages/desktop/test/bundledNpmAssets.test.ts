import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BUNDLED_NPM_INTEGRITY,
  BUNDLED_NPM_VERSION,
  bundledNpmTarballUrl,
  stageBundledNpm,
} from "../scripts/bundled-npm-assets.mjs";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-bundled-npm-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 按 npm registry tarball 布局（顶层 package/）打一个最小 npm 包。 */
async function createFakeNpmTarball(root: string, options: { withNpx?: boolean } = {}) {
  const sourceRoot = join(root, "source");
  const packageRoot = join(sourceRoot, "package");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(join(packageRoot, "docs"), { recursive: true });
  await mkdir(join(packageRoot, "man", "man1"), { recursive: true });
  await mkdir(join(packageRoot, "node_modules", "dep"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), '{"name":"npm"}');
  await writeFile(join(packageRoot, "bin", "npm-cli.js"), "// npm");
  if (options.withNpx !== false) {
    await writeFile(join(packageRoot, "bin", "npx-cli.js"), "// npx");
  }
  await writeFile(join(packageRoot, "docs", "index.html"), "docs");
  await writeFile(join(packageRoot, "man", "man1", "npm.1"), "man");
  await writeFile(join(packageRoot, "node_modules", "dep", "index.js"), "// dep");
  const tarballPath = join(root, "npm.tgz");
  execFileSync("tar", ["-czf", tarballPath, "-C", sourceRoot, "package"]);
  const integrity = `sha512-${createHash("sha512")
    .update(await readFile(tarballPath))
    .digest("base64")}`;
  return { integrity, tarballPath };
}

describe("bundled npm constants", () => {
  it("pins an exact npm version and its registry sha512", () => {
    expect(BUNDLED_NPM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BUNDLED_NPM_INTEGRITY).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    expect(bundledNpmTarballUrl("12.2.0")).toBe("https://registry.npmjs.org/npm/-/npm-12.2.0.tgz");
  });
});

describe("stageBundledNpm", () => {
  it("downloads, verifies and stages npm without docs and man pages", async () => {
    const root = await makeRoot();
    const fake = await createFakeNpmTarball(root);
    const download = vi.fn(async (_url: string, destination: string) => {
      await copyFile(fake.tarballPath, destination);
    });
    const glmDir = join(root, "glm");

    const stagedRoot = await stageBundledNpm({
      cacheDir: join(root, "cache"),
      download,
      glmDir,
      integrity: fake.integrity,
      version: "1.2.3",
    });

    expect(stagedRoot).toBe(join(glmDir, "node-runtime", "npm"));
    expect(download).toHaveBeenCalledWith(
      "https://registry.npmjs.org/npm/-/npm-1.2.3.tgz",
      expect.any(String),
    );
    expect(existsSync(join(stagedRoot, "bin", "npm-cli.js"))).toBe(true);
    expect(existsSync(join(stagedRoot, "bin", "npx-cli.js"))).toBe(true);
    expect(existsSync(join(stagedRoot, "node_modules", "dep", "index.js"))).toBe(true);
    expect(existsSync(join(stagedRoot, "docs"))).toBe(false);
    expect(existsSync(join(stagedRoot, "man"))).toBe(false);
  });

  it("reuses a verified cached tarball without downloading", async () => {
    const root = await makeRoot();
    const fake = await createFakeNpmTarball(root);
    const cacheDir = join(root, "cache");
    await mkdir(cacheDir, { recursive: true });
    await copyFile(fake.tarballPath, join(cacheDir, "npm-1.2.3.tgz"));
    const download = vi.fn();

    await stageBundledNpm({
      cacheDir,
      download,
      glmDir: join(root, "glm"),
      integrity: fake.integrity,
      version: "1.2.3",
    });

    expect(download).not.toHaveBeenCalled();
  });

  it("replaces a corrupt cached tarball", async () => {
    const root = await makeRoot();
    const fake = await createFakeNpmTarball(root);
    const cacheDir = join(root, "cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "npm-1.2.3.tgz"), "corrupt");
    const download = vi.fn(async (_url: string, destination: string) => {
      await copyFile(fake.tarballPath, destination);
    });

    await stageBundledNpm({
      cacheDir,
      download,
      glmDir: join(root, "glm"),
      integrity: fake.integrity,
      version: "1.2.3",
    });

    expect(download).toHaveBeenCalledTimes(1);
    expect(await readFile(join(cacheDir, "npm-1.2.3.tgz"))).toEqual(
      await readFile(fake.tarballPath),
    );
  });

  it("rejects a download whose sha512 does not match and keeps no cache", async () => {
    const root = await makeRoot();
    const fake = await createFakeNpmTarball(root);
    const cacheDir = join(root, "cache");

    await expect(
      stageBundledNpm({
        cacheDir,
        download: async (_url: string, destination: string) => {
          await copyFile(fake.tarballPath, destination);
        },
        glmDir: join(root, "glm"),
        integrity: "sha512-AAAA",
        version: "1.2.3",
      }),
    ).rejects.toThrow(/sha512 mismatch/);
    expect(existsSync(join(cacheDir, "npm-1.2.3.tgz"))).toBe(false);
  });

  it("fails when the package has no npx entry", async () => {
    const root = await makeRoot();
    const fake = await createFakeNpmTarball(root, { withNpx: false });

    await expect(
      stageBundledNpm({
        cacheDir: join(root, "cache"),
        download: async (_url: string, destination: string) => {
          await copyFile(fake.tarballPath, destination);
        },
        glmDir: join(root, "glm"),
        integrity: fake.integrity,
        version: "1.2.3",
      }),
    ).rejects.toThrow(/npx-cli\.js/);
  });
});
